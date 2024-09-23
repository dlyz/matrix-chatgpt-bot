import Keyv from "keyv";
import OpenAI from "openai";
import type {
	ChatCompletionContentPart,
	ChatCompletionCreateParamsBase,
	ChatCompletionMessageParam,
	ChatCompletionRole,
	ChatCompletionUserMessageParam
} from "openai/resources/chat/completions";
import crypto from 'crypto';
import { Tiktoken, encoding_for_model } from "tiktoken";
import { LogService } from "matrix-bot-sdk";
import { CompletionUsage } from "openai/resources/completions";

export { CompletionUsage }

export interface ChatClientOptions {
	modelId: string,
	temperature?: number,
	systemMessage?: string,
	maxInputTokens?: number,
	maxCompletionTokens?: number,
	firstChunkSize?: number,

	// workaround for Element bug that does not autoupdate message after the first edit.
	useTwoChunksForFirstReply?: boolean,
}


interface ConversationMessage {
	id: string,
	parentMessageId: string,
	role: 'system' | 'user' | 'assistant' | 'tool',
	message: string,
	image?: ConversationMessageImage,
}

interface ConversationMessageImage {
	url: string,
}

interface Conversation {
	messages: Array<ConversationMessage>,
	createdAt: number,
}

export interface ChatClientResult extends ConversationRef {
	response: string,
	isLastChunk?: boolean,
	unexpectedFinishReason?: string,
	usage?: CompletionUsage
}

export interface ConversationRef {
	conversationId: string,
	tailMessageId: string,
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

		try {
			this.tokenEncoding = encoding_for_model(options.modelId as any);
		} catch(ex) {
			const fallbackTokenModel = 'gpt-4-vision-preview'
			this.tokenEncoding = encoding_for_model(fallbackTokenModel);
			LogService.warn(
				'ChatClient',
				`Model ${options.modelId} is not supported by the tiktoken, falling back to ${fallbackTokenModel} for token counting.`,
				ex
			)
		}
	}

	private async getConversation(conversationRef: Partial<ConversationRef>) {

		const conversationId = conversationRef.conversationId || crypto.randomUUID();
		const tailMessageId = conversationRef.tailMessageId || crypto.randomUUID();

		let conversation = await this.conversationsCache.get(conversationId);

		let isNewConversation = false;
		if (!conversation) {
			conversation = {
				messages: [],
				createdAt: Date.now(),
			};
			isNewConversation = true;
		}

		return {
			conversationId,
			tailMessageId,
			conversation,
			isNewConversation,
		}
	}

	async saveImage(
		imageUrl: string,
		conversationRef: Partial<ConversationRef>
	): Promise<ConversationRef> {
		const { conversationId, conversation, tailMessageId } = await this.getConversation(conversationRef);

		let userMessage: ConversationMessage = {
			id: crypto.randomUUID(),
			parentMessageId: tailMessageId,
			role: 'user',
			message: '',
			image: { url: imageUrl },
		};
		conversation.messages.push(userMessage);

		await this.conversationsCache.set(conversationId, conversation);

		return {
            conversationId,
            tailMessageId: userMessage.id,
        };
	}

	private async prepareRequest(
		newMessage: string,
		conversationRef: Partial<ConversationRef>
	) {
		// common code for streaming and non-streaming

		const {
			conversationId,
			conversation,
			isNewConversation,
			tailMessageId,
		} = await this.getConversation(conversationRef);

		const userMessage: ConversationMessage = {
			id: crypto.randomUUID(),
			parentMessageId: tailMessageId,
			role: 'user',
			message: newMessage,
		};

		conversation.messages.push(userMessage);

		const messagesThread = getMessageList(conversation.messages, userMessage.id);
		let oaiHistory = toOaiHistory(messagesThread);
		oaiHistory = constraintInput(this.tokenEncoding, oaiHistory, this.options.maxInputTokens);

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
			max_completion_tokens: this.options.maxCompletionTokens
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
		conversationRef: Partial<ConversationRef>
	): Promise<ChatClientResult> {

		const {
			requestParams,
			userMessage,
			conversationId,
			conversation
		} = await this.prepareRequest(newMessage, conversationRef);

		const oaiCompletion = await this.openAiClient.chat.completions.create({
			...requestParams,
			stream: false,
		});

		const oaiReply = oaiCompletion.choices[0];
		const oaiReplyMessage = oaiReply.message;

        const replyMessage = {
            id: crypto.randomUUID(),
            parentMessageId: userMessage.id,
            role: oaiReplyMessage.role,
            message: oaiReplyMessage.content || "",
        };

        conversation.messages.push(replyMessage);

		await this.conversationsCache.set(conversationId, conversation);

		let unexpectedFinishReason = undefined
		if (oaiReply.finish_reason !== "stop") {
			unexpectedFinishReason = oaiReply.finish_reason || undefined
		}

        return {
            response: replyMessage.message,
            conversationId,
            tailMessageId: replyMessage.id,
			unexpectedFinishReason,
			usage: oaiCompletion.usage,
        };
	}


	async * sendMessageStreamed(
		newMessage: string,
		conversationRef: Partial<ConversationRef>
	): AsyncIterableIterator<ChatClientResult> {

		const {
			requestParams,
			userMessage,
			conversationId,
			conversation,
			isNewConversation
		} = await this.prepareRequest(newMessage, conversationRef);

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

				let unexpectedFinishReason = undefined
				if (isLastChunk && oaiReplyChunk.finish_reason !== "stop") {
					unexpectedFinishReason = oaiReplyChunk.finish_reason || undefined
				}

				yield {
					conversationId,
					tailMessageId: replyMessage.id,
					response: replyMessage.message,
					isLastChunk,
					unexpectedFinishReason,
					usage: oaiCompletion.usage,
				};
			}
		}

		await this.conversationsCache.set(conversationId, conversation);
	}
}



function constraintInput<T extends ChatCompletionMessageParam>(
	tokenEncoding: Tiktoken,
	fullHistory: T[],
	maxInputTokens?: number
) {
	if (maxInputTokens == undefined) return fullHistory;

	let currentTokens = 0;
	const result: T[] = [];
	for (let i = fullHistory.length - 1; i >= 0; --i) {
		const message = fullHistory[i]
		let tokens;
		if (!message.content) {
			tokens = 0;
		}
		else if (typeof message.content === 'string') {
			tokens = tokenEncoding.encode(message.content).length;
		} else {
			tokens = 0;
			for (const part of message.content) {
				if (part.type === 'text') {
					tokens += tokenEncoding.encode(part.text).length;
				} else {
					// todo: count images precisely
					tokens += 765;
				}
			}
		}

		if (currentTokens + tokens > maxInputTokens) {
			if (currentTokens === 0) {
				// this is the last message and we can not fit it in our constraints
				throw new Error(`Last message is too long. Max total prompt token count is ${maxInputTokens}, but message is ${tokens} tokens long.`);
			}

			break;
		}

		currentTokens += tokens;
		result.unshift(message);
	}

	return result;
}


function toOaiHistory(messages: ConversationMessage[]) {

	const history: ChatCompletionMessageParam[] = [];
	for (const message of messages) {
		const role = normalizeRole(message.role);


		if (role === 'user') {
			let parts: ChatCompletionContentPart[];

			if (history.at(-1)?.role === 'user') {
				const target = history.at(-1)! as ChatCompletionUserMessageParam;
				if (!target.content) {
					target.content = [];
				} else if (typeof target.content === 'string') {
					target.content = [{ type: "text", text: target.content }];
				}

				parts = target.content;
			} else {
				parts = [];
				history.push({
					role,
					content: parts
				});
			}

			if (message.image) {
				parts.push({
					type: "image_url",
					image_url: { url: message.image.url, detail: 'auto' }
				});
			} else {
				parts.push({
					type: "text",
					text: message.message,
				});
			}

		} else {
			history.push({
				role,
				content: message.message
			});
		}
	}

	return history;

	function normalizeRole(role: string): "system" | "user" | "assistant" {
		// legacy role names conversion
		if (role === 'User') return 'user';
		else if (role === 'ChatGPT') return 'assistant';
		else return role as any;
	}
}

/**
 * Iterate through messages, building an array based on the parentMessageId.
 * Each message has an id and a parentMessageId. The parentMessageId is the id of the message that this message is a reply to.
 * @param messages
 * @param tailMessageId
 * @returns {*[]} An array containing the messages in the order they should be displayed, starting with the root message.
 */
function getMessageList(messages: ConversationMessage[], tailMessageId: string) {
	const orderedMessages: ConversationMessage[] = [];
	let currentMessageId = tailMessageId;
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
