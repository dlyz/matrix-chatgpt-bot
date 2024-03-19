import Keyv from "keyv";
import OpenAI from "openai";
import type { ChatCompletionCreateParamsBase, ChatCompletionMessageParam, ChatCompletionRole } from "openai/resources/chat/completions";
import crypto from 'crypto';
import { Tiktoken, encoding_for_model } from "tiktoken";


export interface ChatClientOptions {
	modelId: string,
	temperature?: number,
	systemMessage?: string,
	maxInputTokens?: number,
	maxOutputTokens?: number,
	firstChunkSize?: number,

	// workaround for Element bug that does not autoupdate message after the first edit.
	useTwoChunksForFirstReply?: boolean,
}


interface ConversationMessage {
	id: string,
	parentMessageId: string,
	role: string,
	message: string,
}

interface Conversation {
	messages: Array<ConversationMessage>,
	createdAt: number,
}

export interface ChatClientResult {
	response: string,
	conversationId: string,
	messageId: string,
	isLastChunk?: boolean,
}

export interface ConversationRef {
	conversationId?: string,
	parentMessageId?: string,
}

export class ChatClient {

	readonly conversationsCache: Keyv<Conversation>;
	private readonly tokenEncoding: Tiktoken;

	constructor(
		readonly openAiClient: OpenAI,
		readonly options: ChatClientOptions,
		cacheOptions: Keyv.Options<any>,
	) {
		cacheOptions.namespace = cacheOptions.namespace || 'chatgpt';
		this.conversationsCache = new Keyv(cacheOptions);
		this.tokenEncoding = encoding_for_model(options.modelId as any);
	}


	private async prepareRequest(
		newMessage: string,
		conversationRef?: ConversationRef
	) {
		// common code for streaming and non-streaming

		const conversationId = conversationRef?.conversationId || crypto.randomUUID();
		const parentMessageId = conversationRef?.parentMessageId || crypto.randomUUID();

		let conversation = await this.conversationsCache.get(conversationId);

		let isNewConversation = false;
		if (!conversation) {
			conversation = {
				messages: [],
				createdAt: Date.now(),
			};
			isNewConversation = true;
		}

		const userMessage: ConversationMessage = {
			id: crypto.randomUUID(),
			parentMessageId,
			role: 'user',
			message: newMessage,
		};

		conversation.messages.push(userMessage);

		const orderedMessages = ChatClient.getMessagesForConversation(conversation.messages, userMessage.id);

		function normalizeRole(role: string): "system" | "user" | "assistant" {
			// legacy role names conversion
			if (role === 'User') return 'user';
			else if (role === 'ChatGPT') return 'assistant';
			else return role as any;
		}

		let oaiHistory = orderedMessages.map(m => ({
			role: normalizeRole(m.role),
			content: m.message,
		} satisfies ChatCompletionMessageParam));

		oaiHistory = this.constraintInput(oaiHistory, this.options.maxInputTokens);

		if (this.options.systemMessage) {
			oaiHistory.unshift({
				role: "system",
				content: this.options.systemMessage
			})
		}

		const requestParams: ChatCompletionCreateParamsBase = {
			model: this.options.modelId,
			temperature: this.options.temperature,
			messages: oaiHistory,
			max_tokens: this.options.maxOutputTokens,
		};

		return {
			requestParams,
			isNewConversation,
			userMessage,
			conversationId,
			conversation
		}
	}


	async sendMessage(
		newMessage: string,
		conversationRef?: ConversationRef
	): Promise<ChatClientResult> {

		const { requestParams, userMessage, conversationId, conversation } = await this.prepareRequest(newMessage, conversationRef);

		const oaiCompletion = await this.openAiClient.chat.completions.create({
			...requestParams,
			stream: false,
		});

		const oaiReplyMessage = oaiCompletion.choices[0].message;

        const replyMessage = {
            id: crypto.randomUUID(),
            parentMessageId: userMessage.id,
            role: oaiReplyMessage.role,
            message: oaiReplyMessage.content || "",
        };

        conversation.messages.push(replyMessage);

		await this.conversationsCache.set(conversationId, conversation);

        return {
            response: replyMessage.message,
            conversationId,
            messageId: replyMessage.id,
        };
	}


	async * sendMessageStreamed(
		newMessage: string,
		conversationRef?: { conversationId?: string, parentMessageId?: string }
	): AsyncIterableIterator<ChatClientResult> {

		const { requestParams, userMessage, conversationId, conversation, isNewConversation } = await this.prepareRequest(newMessage, conversationRef);

		const oaiCompletionStream = await this.openAiClient.chat.completions.create({
			...requestParams,
			stream: true,
		});

		let maxBufferLength = Math.max(128, this.options.firstChunkSize || 512);
		let buffer = "";

		let replyMessage: ConversationMessage = {
			id: crypto.randomUUID(),
			parentMessageId: userMessage.id,
			role: "assistant",
			message: "",
		};

		conversation.messages.push(replyMessage);

		for await (const oaiCompletion of oaiCompletionStream) {
			const oaiReplyChunk = oaiCompletion.choices[0];
			const oaiReplyMessage = oaiReplyChunk.delta;
			if (oaiReplyMessage.role) {
				replyMessage.role = oaiReplyMessage.role;
			}

			const isLastChunk = oaiReplyChunk.finish_reason != null;
			buffer += oaiReplyMessage.content || "";
			if ((buffer.length >= maxBufferLength) || isLastChunk) {
				replyMessage.message += buffer;
				buffer = "";
				maxBufferLength = Math.round(maxBufferLength * 1.618);

				if (isNewConversation && this.options.useTwoChunksForFirstReply) {
					maxBufferLength = Number.MAX_SAFE_INTEGER;
				}

				yield {
					response: replyMessage.message,
					conversationId,
					messageId: replyMessage.id,
					isLastChunk,
				};
			}
		}

		await this.conversationsCache.set(conversationId, conversation);
	}

	private constraintInput<T extends ChatCompletionMessageParam>(fullHistory: T[], maxInputTokens?: number) {
		if (maxInputTokens == undefined) return fullHistory;

		let currentTokens = 0;
		const result = [];
		for (let i = fullHistory.length - 1; i >= 0; --i) {
			const message = fullHistory[i]
			if (typeof message.content !== 'string') {
				// todo: count images
				continue;
			}

			const tokens = this.tokenEncoding.encode(message.content).length;
			if (currentTokens + tokens > maxInputTokens) {
				if (currentTokens === 0) {
                    throw new Error(`Prompt is too long. Max token count is ${maxInputTokens}, but prompt is ${currentTokens + tokens} tokens long.`);
				}

				break;
			}

			result.unshift(message);
		}

		return result;
	}

	/**
	 * Iterate through messages, building an array based on the parentMessageId.
	 * Each message has an id and a parentMessageId. The parentMessageId is the id of the message that this message is a reply to.
	 * @param messages
	 * @param parentMessageId
	 * @returns {*[]} An array containing the messages in the order they should be displayed, starting with the root message.
	 */
	private static getMessagesForConversation(messages: ConversationMessage[], parentMessageId: string) {
		const orderedMessages: ConversationMessage[] = [];
		let currentMessageId = parentMessageId;
		while (currentMessageId) {
			// eslint-disable-next-line no-loop-func
			const message = messages.find(m => m.id === currentMessageId);
			if (!message) {
				break;
			}
			orderedMessages.unshift(message);
			currentMessageId = message.parentMessageId;
		}

		return orderedMessages;
	}
}
