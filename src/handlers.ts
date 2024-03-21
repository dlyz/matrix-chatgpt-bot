import { LogService, MatrixClient, MessageEvent, UserID } from "matrix-bot-sdk";
import { botConfig } from "./env.js";
import { sendError, sendReply } from "./utils.js";
import { ChatClient } from "./ChatClient.js";
import { IEventRelation, ImageMessageContent, MessageContent, MsgType, TextMessageContent } from "./matrixTypes.js";

function isThread(relatesTo: IEventRelation | undefined): relatesTo is IEventRelation {
  return !!relatesTo && relatesTo.rel_type === "m.thread";
}

function getThreadRootEventId(relatesTo: IEventRelation | undefined) {
  return isThread(relatesTo) ? relatesTo.event_id : undefined
}

export default class CommandHandler {

  // Variables so we can cache the bot's display name and ID for command matching later.
  private displayName: string | undefined;
  private userId: string = undefined!;
  private localpart: string = undefined!;

  constructor(private client: MatrixClient, private chatGPT: ChatClient) { }

  public async start() {
    await this.prepareProfile();  // Populate the variables above (async)
    this.client.on("room.message", this.onMessage.bind(this)); // Set up the event handler
  }

  private async prepareProfile() {
    this.userId = await this.client.getUserId();
    this.localpart = new UserID(this.userId).localpart;
    try {
      const profile = await this.client.getUserProfile(this.userId);
      if (profile && profile['displayname']) this.displayName = profile['displayname'];
    } catch (e) {
      LogService.warn("CommandHandler", e); // Non-fatal error - we'll just log it and move on.
    }
  }

  private shouldProcess(event: MessageEvent<MessageContent>, roomId: string)
    : event is MessageEvent<TextMessageContent> | MessageEvent<ImageMessageContent> {
    // Ignore ourselves
    if (event.sender === this.userId) return false;
    // Ignore if on blacklist if set
    if (botConfig.MATRIX_BLACKLIST && botConfig.MATRIX_BLACKLIST.split(" ").find(b => event.sender.endsWith(b))) return false;
    // Ignore if not on whitelist if set
    if (botConfig.MATRIX_WHITELIST && !botConfig.MATRIX_WHITELIST.split(" ").find(w => event.sender.endsWith(w))) return false;
    // Ignore if on room blacklist if set
    if (botConfig.MATRIX_ROOM_BLACKLIST && botConfig.MATRIX_ROOM_BLACKLIST.split(" ").find(b => roomId.endsWith(b))) return false;
    // Ignore if not on room whitelist if set
    if (botConfig.MATRIX_ROOM_WHITELIST && !botConfig.MATRIX_ROOM_WHITELIST.split(" ").find(w => roomId.endsWith(w))) return false;
    // Ignore old messages
    if (Date.now() - event.raw.origin_server_ts > 60000) return false;
    // Ignore edits
    if (event.content["m.relates_to"]?.["rel_type"] === "m.replace") return false;
    // Ignore everything which is not text
    if ((['m.text', 'm.image'] satisfies MsgType[] as string[]).indexOf(event.content.msgtype) === -1) return false;

    return true;
  }


  private getRootEventId(event: MessageEvent<MessageContent>): string {
    return getThreadRootEventId(event.content["m.relates_to"]) ?? event.eventId;
  }

  private getStorageKey(event: MessageEvent<MessageContent>, roomId: string): string {
    const rootEventId: string = this.getRootEventId(event)
    if (botConfig.CHATGPT_CONTEXT == "room") {
      return roomId
    } else if (botConfig.CHATGPT_CONTEXT == "thread") {
      return rootEventId
    } else {  // CHATGPT_CONTEXT set to both.
      return (rootEventId !== event.eventId) ? rootEventId : roomId;
    }
  }

  private async getStoredConversation(storageKey: string, roomId: string) {
    // todo: get rid of two conversation stores
    let storedValue = await this.client.storageProvider.readValue('gpt-' + storageKey)
    if (storedValue == undefined && storageKey != roomId) {
      storedValue = await this.client.storageProvider.readValue('gpt-' + roomId)
    }

    if (storedValue != undefined) {
      const result: StoredConversation = JSON.parse(storedValue);

      // fixing legacy configs
      result.config = Object.assign(makeDefaultConversationConfig(), result.config ?? {});

      return result;
    } else {
      return undefined;
    }
  }

  private async saveStoredConversation(
    storedConversation: StoredConversation,
    storageKey: string,
    roomId: string,
    eventId: string
  ) {
    const convString = JSON.stringify(storedConversation);
    await this.client.storageProvider.storeValue('gpt-' + storageKey, convString);
    if ((storageKey === roomId) && (botConfig.CHATGPT_CONTEXT === "both")) {
      await this.client.storageProvider.storeValue('gpt-' + eventId, convString);
    }
  }

  private async getBodyWithoutPrefix(
    conversation: StoredConversation | undefined,
    config: StoredConversationConfig,
    roomId: string,
    eventContent: MessageContent
  ) {
    const isDm = this.client.dms.isDm(roomId);

    if (!config.MATRIX_PREFIX || (isDm && !config.MATRIX_PREFIX_DM)) {
      // no prefix required
      return eventContent.body;
    }

    const prefixes = [config.MATRIX_PREFIX, `${this.localpart}:`, `${this.displayName}:`, `${this.userId}:`];

    function getAndStripPrefix(text: string) {
      const prefix = prefixes.find(p => text.startsWith(p));
      return prefix ? text.slice(prefix.length).trimStart() : undefined;
    }

    const threadEventId = getThreadRootEventId(eventContent["m.relates_to"]);
    if (threadEventId) {
      if (config.MATRIX_PREFIX_REPLY) {
        return getAndStripPrefix(eventContent.body);
      } else {
        // if we already have a conversation, then we have already checked the root thread message
        return conversation ? eventContent.body : undefined;
      }
    } else {
      return getAndStripPrefix(eventContent.body);
    }
  }

  /**
   * Run when `message` room event is received. The bot only sends a message if needed.
   * @returns Room event handler, which itself returns nothing
   */
  private async onMessage(roomId: string, rawEvent: unknown) {
    try {
      const event = new MessageEvent<MessageContent>(rawEvent);

      if (!this.shouldProcess(event, roomId)) return;


      const storageKey = this.getStorageKey(event, roomId);
      const storedConversation = await this.getStoredConversation(storageKey, roomId);
      const conversationConfig = storedConversation?.config ?? makeDefaultConversationConfig();
      const conversationRef = {
        conversationId: storedConversation?.conversationId,
        tailMessageId: storedConversation?.messageId
      };

      const content = event.content;

      const bodyWithoutPrefix = await this.getBodyWithoutPrefix(storedConversation, conversationConfig, roomId, content);
      if (bodyWithoutPrefix === undefined) {
        // ignored because the prefix required but absent or the body is undefined
        return;
      }


      let result;
      if (content.msgtype === 'm.text') {

        if (!bodyWithoutPrefix) {
          await sendError(this.client, "Body is empty", roomId, event.eventId);
          return;
        }

        await Promise.all([
          this.client.sendReadReceipt(roomId, event.eventId),
          this.client.setTyping(roomId, true, botConfig.CHATGPT_TIMEOUT)
        ]);

        const streamed = botConfig.MATRIX_FIRST_CHUNK_SIZE !== undefined && botConfig.MATRIX_FIRST_CHUNK_SIZE > 0;
        if (!streamed) {
          try {
            result = await this.chatGPT.sendMessage(await bodyWithoutPrefix, conversationRef)
          }
          catch (error: any) {
            LogService.error(`OpenAI-API Error: ${error}`);
            sendError(this.client, `The bot has encountered an error, please contact your administrator (Error code ${error.status || "Unknown"}).`, roomId, event.eventId);
            return;
          };

          await Promise.all([
            this.client.setTyping(roomId, false, 500),
            sendReply({
              client: this.client,
              roomId: roomId,
              rootEventId: botConfig.MATRIX_THREADS ? this.getRootEventId(event) : undefined,
              text: result.response,
              rich: botConfig.MATRIX_RICH_TEXT,
            })
          ]);

        } else {

          let matrixError = false;
          try {
            const stream = this.chatGPT.sendMessageStreamed(bodyWithoutPrefix, conversationRef)
            let messageId = undefined;

            for await (let chunk of stream) {

              result = {
                conversationId: chunk.conversationId,
                messageId: chunk.messageId,
              }

              try {
                const resultingMessageId = await sendReply({
                  client: this.client,
                  roomId: roomId,
                  rootEventId: botConfig.MATRIX_THREADS ? this.getRootEventId(event) : undefined,
                  editingEventId: messageId,
                  text: chunk.response + (chunk.isLastChunk ? '' : "\n\n*...generating...*"),
                  rich: botConfig.MATRIX_RICH_TEXT,
                });

                messageId = messageId || resultingMessageId;

                if (chunk.isLastChunk) {
                  await this.client.setTyping(roomId, false, 500)
                } else {
                  await this.client.setTyping(roomId, true, botConfig.CHATGPT_TIMEOUT)
                }

              } catch (e) {
                matrixError = true;
                throw e;
              }
            }

            if (!result) {
              throw new Error("ChatGPT produced no chunks");
            }
          }
          catch (error: any) {
            if (matrixError) {
              throw error;
            }

            LogService.error(`OpenAI-API Error: ${error}`);
            sendError(this.client, `The bot has encountered an error, please contact your administrator (Error code ${error.status || "Unknown"}).`, roomId, event.eventId);
            return;
          };
        }

      } else if (content.msgtype === 'm.image') {

        const file = await this.client.crypto.decryptMedia(content.file);
        const imageUrl = `data:${content.info?.mimetype ?? 'image/png'};base64,${file.toString('base64')}`;

        result = await this.chatGPT.saveImage(imageUrl, conversationRef);

        await this.client.sendReadReceipt(roomId, event.eventId);

      } else {
        return;
      }

      const newConversation: StoredConversation = {
        conversationId: result.conversationId,
        messageId: result.messageId,
        config: conversationConfig
      }

      await this.saveStoredConversation(newConversation, storageKey, roomId, event.eventId);

    } catch (err) {
      console.error(err);
    }
  }

}

type StoredConversationConfig = {
  // TODO: think is this required to be saved in the conv. think about how branches are processed and stored
  MATRIX_PREFIX: string;
  MATRIX_PREFIX_REPLY: boolean;
  MATRIX_PREFIX_DM: boolean;
}

type StoredConversation = {
  conversationId: string;
  messageId: string;
  config: StoredConversationConfig;
}

function makeDefaultConversationConfig(): StoredConversationConfig {
  return {
    MATRIX_PREFIX: botConfig.MATRIX_DEFAULT_PREFIX,
    MATRIX_PREFIX_REPLY: botConfig.MATRIX_DEFAULT_PREFIX_REPLY,
    MATRIX_PREFIX_DM: botConfig.MATRIX_PREFIX_DM,
  }
}