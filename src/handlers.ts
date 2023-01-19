import { ChatGPTAPIBrowser } from "chatgpt";
import { LogService, MatrixClient, UserID } from "matrix-bot-sdk";
import { MATRIX_DEFAULT_PREFIX_REPLY, MATRIX_DEFAULT_PREFIX, MATRIX_BLACKLIST, MATRIX_WHITELIST, MATRIX_RICH_TEXT, MATRIX_PREFIX_DM } from "./env.js";
import { RelatesTo, MessageEvent, StoredConversation, StoredConversationConfig } from "./interfaces.js";
import { sendChatGPTMessage, sendError, sendThreadReply } from "./utils.js";

export default class CommandHandler {

  // Variables so we can cache the bot's display name and ID for command matching later.
  private displayName: string;
  private userId: string;
  private localpart: string;

  constructor(private client: MatrixClient, private chatGPT: ChatGPTAPIBrowser) { }

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

  private shouldIgnore(event: MessageEvent): boolean {
    if (event.sender === this.userId) return true;                                                          // Ignore ourselves
    if (MATRIX_BLACKLIST &&  MATRIX_BLACKLIST.split(" ").find(b => event.sender.endsWith(b))) return true;  // Ignore if on blacklist if set
    if (MATRIX_WHITELIST && !MATRIX_WHITELIST.split(" ").find(w => event.sender.endsWith(w))) return true;  // Ignore if not on whitelist if set
    if (Date.now() - event.origin_server_ts > 10000) return true;                                           // Ignore old messages
    if (event.content["m.relates_to"]?.["rel_type"] === "m.replace") return true;                           // Ignore edits
    return false;
  }

  private getRootEventId(event: MessageEvent): string {
    const relatesTo: RelatesTo | undefined = event.content["m.relates_to"];
    const isReplyOrThread: boolean = (relatesTo === undefined)
    return (!isReplyOrThread && relatesTo.event_id !== undefined) ? relatesTo.event_id : event.event_id;
  }

  private async getStoredConversation(rootEventId: string): Promise<StoredConversation> {
    const storedValue: string = await this.client.storageProvider.readValue('gpt-' + rootEventId)
    return (storedValue !== undefined) ? JSON.parse(storedValue) : undefined;
  }

  private getConfig(storedConversation: StoredConversation): StoredConversationConfig {
    return (storedConversation !== undefined && storedConversation.config !== undefined) ? storedConversation.config : {};
  }

  private async shouldBePrefixed(config: StoredConversationConfig, roomId: string, event: MessageEvent): Promise<boolean> {
    const relatesTo: RelatesTo | undefined = event.content["m.relates_to"];
    const isReplyOrThread: boolean = (relatesTo === undefined);
    const isDm: boolean = this.client.dms.isDm(roomId);
    const MATRIX_PREFIX: string = (config.MATRIX_PREFIX === undefined) ? MATRIX_DEFAULT_PREFIX : config.MATRIX_PREFIX
    const MATRIX_PREFIX_REPLY: boolean = (config.MATRIX_PREFIX_REPLY === undefined) ? MATRIX_DEFAULT_PREFIX_REPLY : config.MATRIX_PREFIX_REPLY
    let shouldBePrefixed: boolean = (MATRIX_PREFIX && isReplyOrThread) || (MATRIX_PREFIX_REPLY && !isReplyOrThread);
    if (!MATRIX_PREFIX_DM && isDm) shouldBePrefixed=false
    const prefixes = [MATRIX_PREFIX, `${this.localpart}:`, `${this.displayName}:`, `${this.userId}:`];
    if (!isReplyOrThread && !MATRIX_PREFIX_REPLY) {
      if(relatesTo.event_id !== undefined){
        const rootEvent: MessageEvent = await this.client.getEvent(roomId, relatesTo.event_id) // relatesTo is root event.
        const rootPrefixUsed = prefixes.find(p => rootEvent.content.body.startsWith(p));
        if (!rootPrefixUsed && !(!MATRIX_PREFIX_DM && isDm)) return false;  // Ignore unrelated threads or certain dms
      } else { // reply not thread, iterating for a prefix not implemented
        return false;                                                       // Ignore if no relatesTo EventID
      }
    }
    const prefixUsed: string = prefixes.find(p => event.content.body.startsWith(p));
    if (shouldBePrefixed && !prefixUsed) return false;                      // Ignore without prefix if prefixed
    return true;
  }

  private async getBodyWithoutPrefix(event: MessageEvent, config: StoredConversationConfig, shouldBePrefixed: boolean): Promise<string> {
    const MATRIX_PREFIX: string = (config.MATRIX_PREFIX === undefined) ? MATRIX_DEFAULT_PREFIX : config.MATRIX_PREFIX
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
      if (this.shouldIgnore(event)) return;

      const rootEventId = this.getRootEventId(event);
      const storedConversation = await this.getStoredConversation(rootEventId);
      const config = this.getConfig(storedConversation);

      const shouldBePrefixed = await this.shouldBePrefixed(config, roomId, event)
      if (!shouldBePrefixed) return;

      await Promise.all([
        this.client.sendReadReceipt(roomId, event.event_id),
        this.client.setTyping(roomId, true, 10000)
      ]);

      const bodyWithoutPrefix = this.getBodyWithoutPrefix(event, config, shouldBePrefixed);
      if (!bodyWithoutPrefix) {
        await sendError(this.client, "Error with body: " + event.content.body, roomId, event.event_id);
        return;
      }

      const result = await sendChatGPTMessage(this.chatGPT, await bodyWithoutPrefix, storedConversation);
      await Promise.all([
        this.client.setTyping(roomId, false, 500),
        sendThreadReply(this.client, roomId, rootEventId, `${result.response}`, MATRIX_RICH_TEXT)
      ]);

      await this.client.storageProvider.storeValue('gpt-' + rootEventId, JSON.stringify({
        conversationId: result.conversationId, messageId: result.messageId,
        config: ((storedConversation !== undefined && storedConversation.config !== undefined) ? storedConversation.config : {}),
      }));
    } catch (err) {
      console.error(err);
    }
  }
}
