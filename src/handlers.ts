import { LogService, MatrixClient, UserID } from "matrix-bot-sdk";
import { botConfig } from "./env.js";
import { RelatesTo, MessageEvent, StoredConversation, StoredConversationConfig } from "./interfaces.js";
import { sendError, sendReply } from "./utils.js";
import { ChatClient } from "./ChatClient.js";

export default class CommandHandler {

  // Variables so we can cache the bot's display name and ID for command matching later.
  private displayName: string;
  private userId: string;
  private localpart: string;

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

  private shouldIgnore(event: MessageEvent, roomId: string): boolean {
    if (event.sender === this.userId) return true;                                                              // Ignore ourselves
    if (botConfig.MATRIX_BLACKLIST && botConfig.MATRIX_BLACKLIST.split(" ").find(b => event.sender.endsWith(b))) return true;      // Ignore if on blacklist if set
    if (botConfig.MATRIX_WHITELIST && !botConfig.MATRIX_WHITELIST.split(" ").find(w => event.sender.endsWith(w))) return true;      // Ignore if not on whitelist if set
    if (botConfig.MATRIX_ROOM_BLACKLIST && botConfig.MATRIX_ROOM_BLACKLIST.split(" ").find(b => roomId.endsWith(b))) return true;  // Ignore if on room blacklist if set
    if (botConfig.MATRIX_ROOM_WHITELIST && !botConfig.MATRIX_ROOM_WHITELIST.split(" ").find(w => roomId.endsWith(w))) return true;  // Ignore if not on room whitelist if set
    if (Date.now() - event.origin_server_ts > 60000) return true;                                               // Ignore old messages
    if (event.content["m.relates_to"]?.["rel_type"] === "m.replace") return true;                               // Ignore edits
    if (botConfig.CHATGPT_IGNORE_MEDIA && event.content.msgtype !== "m.text") return true;                                // Ignore everything which is not text if set
    return false;
  }

  private getRootEventId(event: MessageEvent): string {
    const relatesTo: RelatesTo | undefined = event.content["m.relates_to"];
    const isReplyOrThread: boolean = (relatesTo === undefined)
    return (!isReplyOrThread && relatesTo.event_id !== undefined) ? relatesTo.event_id : event.event_id;
  }

  private getStorageKey(event: MessageEvent, roomId: string): string {
    const rootEventId: string = this.getRootEventId(event)
    if (botConfig.CHATGPT_CONTEXT == "room") {
      return roomId
    } else if (botConfig.CHATGPT_CONTEXT == "thread") {
      return rootEventId
    } else {  // CHATGPT_CONTEXT set to both.
      return (rootEventId !== event.event_id) ? rootEventId : roomId;
    }
  }

  private async getStoredConversation(storageKey: string, roomId: string): Promise<StoredConversation> {
    let storedValue: string = await this.client.storageProvider.readValue('gpt-' + storageKey)
    if (storedValue == undefined && storageKey != roomId) storedValue = await this.client.storageProvider.readValue('gpt-' + roomId)
    return (storedValue !== undefined) ? JSON.parse(storedValue) : undefined;
  }

  private getConfig(storedConversation: StoredConversation): StoredConversationConfig {
    return (storedConversation !== undefined && storedConversation.config !== undefined) ? storedConversation.config : {};
  }

  private async shouldBePrefixed(config: StoredConversationConfig, roomId: string, event: MessageEvent): Promise<boolean> {
    const relatesTo: RelatesTo | undefined = event.content["m.relates_to"];
    const isReplyOrThread: boolean = (relatesTo === undefined);
    const isDm: boolean = this.client.dms.isDm(roomId);
    const MATRIX_PREFIX: string = (config.MATRIX_PREFIX === undefined) ? botConfig.MATRIX_DEFAULT_PREFIX : config.MATRIX_PREFIX
    const MATRIX_PREFIX_REPLY: boolean = (config.MATRIX_PREFIX_REPLY === undefined) ? botConfig.MATRIX_DEFAULT_PREFIX_REPLY : config.MATRIX_PREFIX_REPLY
    let shouldBePrefixed: boolean = (MATRIX_PREFIX && isReplyOrThread) || (MATRIX_PREFIX_REPLY && !isReplyOrThread);
    if (!botConfig.MATRIX_PREFIX_DM && isDm) shouldBePrefixed=false
    const prefixes = [MATRIX_PREFIX, `${this.localpart}:`, `${this.displayName}:`, `${this.userId}:`];
    if (!isReplyOrThread && !MATRIX_PREFIX_REPLY) {
      if(relatesTo.event_id !== undefined){
        const rootEvent: MessageEvent = await this.client.getEvent(roomId, relatesTo.event_id) // relatesTo is root event.
        const rootPrefixUsed = prefixes.find(p => rootEvent.content.body.startsWith(p));
        if (MATRIX_PREFIX && !rootPrefixUsed && !(!botConfig.MATRIX_PREFIX_DM && isDm)) return false;  // Ignore unrelated threads or certain dms
      } else { // reply not thread, iterating for a prefix not implemented
        return false;                                                       // Ignore if no relatesTo EventID
      }
    }
    const prefixUsed: string = prefixes.find(p => event.content.body.startsWith(p));
    if (shouldBePrefixed && !prefixUsed) return false;                      // Ignore without prefix if prefixed
    return true;
  }

  private async getBodyWithoutPrefix(event: MessageEvent, config: StoredConversationConfig, shouldBePrefixed: boolean): Promise<string> {
    const MATRIX_PREFIX: string = (config.MATRIX_PREFIX === undefined) ? botConfig.MATRIX_DEFAULT_PREFIX : config.MATRIX_PREFIX
    const prefixUsed: string = [MATRIX_PREFIX, `${this.localpart}:`, `${this.displayName}:`, `${this.userId}:`].find(p => event.content.body.startsWith(p));
    const trimLength = (shouldBePrefixed && prefixUsed) ? prefixUsed.length : 0;
    return event.content.body.slice(trimLength).trimStart();
  }

  /**
   * Run when `message` room event is received. The bot only sends a message if needed.
   * @returns Room event handler, which itself returns nothing
   */
  private async onMessage(roomId: string, event: MessageEvent) {
    try {
      if (this.shouldIgnore(event, roomId)) return;

      const storageKey = this.getStorageKey(event, roomId);
      const storedConversation = await this.getStoredConversation(storageKey, roomId);
      const config = this.getConfig(storedConversation);

      const shouldBePrefixed = await this.shouldBePrefixed(config, roomId, event)
      if (!shouldBePrefixed) return;

      await Promise.all([
        this.client.sendReadReceipt(roomId, event.event_id),
        this.client.setTyping(roomId, true, botConfig.CHATGPT_TIMEOUT)
      ]);

      const bodyWithoutPrefix = this.getBodyWithoutPrefix(event, config, shouldBePrefixed);
      if (!bodyWithoutPrefix) {
        await sendError(this.client, "Error with body: " + event.content.body, roomId, event.event_id);
        return;
      }

      let result;

      const streamed = botConfig.MATRIX_FIRST_CHUNK_SIZE > 0;
      if (!streamed) {
        try {
          result = await this.chatGPT.sendMessage(await bodyWithoutPrefix, { conversationId: storedConversation?.conversationId, parentMessageId: storedConversation?.messageId })
        }
        catch (error) {
          LogService.error(`OpenAI-API Error: ${error}`);
          sendError(this.client, `The bot has encountered an error, please contact your administrator (Error code ${error.status || "Unknown"}).`, roomId, event.event_id);
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
          const stream = this.chatGPT.sendMessageStreamed(await bodyWithoutPrefix, { conversationId: storedConversation?.conversationId, parentMessageId: storedConversation?.messageId })
          let messageId = undefined;

          for await (let chunk of stream) {

            result = {
              conversationId: chunk.conversationId,
              messageId: chunk.messageId,
            }

            try
            {
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
        }
        catch (error) {
          if (matrixError) {
            throw error;
          }

          LogService.error(`OpenAI-API Error: ${error}`);
          sendError(this.client, `The bot has encountered an error, please contact your administrator (Error code ${error.status || "Unknown"}).`, roomId, event.event_id);
          return;
        };
      }

      const storedConfig = ((storedConversation !== undefined && storedConversation.config !== undefined) ? storedConversation.config : {})
      const configString: string = JSON.stringify({conversationId: result.conversationId, messageId: result.messageId, config: storedConfig})
      await this.client.storageProvider.storeValue('gpt-' + storageKey, configString);
      if ((storageKey === roomId) && (botConfig.CHATGPT_CONTEXT === "both")) await this.client.storageProvider.storeValue('gpt-' + event.event_id, configString);
    } catch (err) {
      console.error(err);
    }
  }
}
