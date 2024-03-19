import Keyv from "keyv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionRole } from "openai/resources/chat/completions";
import crypto from 'crypto';
import { Tiktoken, encoding_for_model } from "tiktoken";


export interface ChatClientOptions {
	modelId: string,
	temperature?: number,
	systemMessage?: string,
	maxInputTokens?: number,
	maxOutputTokens?: number,
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

	async sendMessage(
		newMessage: string,
		conversationRef?: { conversationId?: string, parentMessageId?: string }
	): Promise<{ response: string, conversationId: string, messageId: string }> {


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

		const oaiCompletion = await this.openAiClient.chat.completions.create({
			model: this.options.modelId,
			temperature: this.options.temperature,
			messages: oaiHistory,
			max_tokens: this.options.maxOutputTokens,
			stream: false,
		});

		const oaiReplyMessage = oaiCompletion.choices[0].message;

        const replyMessage = {
            id: crypto.randomUUID(),
            parentMessageId: userMessage.id,
            role: oaiReplyMessage.role,
            message: oaiReplyMessage.content?.trim() || "",
        };

        conversation.messages.push(replyMessage);

		await this.conversationsCache.set(conversationId, conversation);

        return {
            response: replyMessage.message,
            conversationId,
            messageId: replyMessage.id,
        };
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
