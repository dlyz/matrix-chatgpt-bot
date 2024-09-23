import Keyv from 'keyv'
import { KeyvFile } from 'keyv-file';
import {
  MatrixAuth, MatrixClient, AutojoinRoomsMixin, LogService, LogLevel, RichConsoleLogger,
  RustSdkCryptoStorageProvider, IStorageProvider, SimpleFsStorageProvider, ICryptoStorageProvider,
} from "matrix-bot-sdk";

import * as path from "path";
import { botConfig } from './env.js'
import CommandHandler from "./handlers.js"
import { KeyvStorageProvider } from './storage.js'
import { parseMatrixUsernamePretty } from './utils.js';

import OpenAI from 'openai';
import { ChatClient, ChatClientOptions } from './ChatClient.js';

LogService.setLogger(new RichConsoleLogger());
// LogService.setLevel(LogLevel.DEBUG);  // Shows the Matrix sync loop details - not needed most of the time
LogService.setLevel(LogLevel.INFO);
// LogService.muteModule("Metrics");
LogService.trace = LogService.debug;
if (botConfig.KEYV_URL && botConfig.KEYV_BACKEND === 'file') LogService.warn('config', 'KEYV_URL is ignored when KEYV_BACKEND is set to `file`')

let storage: IStorageProvider
if (botConfig.KEYV_BOT_STORAGE) {
  storage = new KeyvStorageProvider('chatgpt-bot-storage');
} else {
  storage = new SimpleFsStorageProvider(path.join(botConfig.DATA_PATH, "bot.json")); // /storage/bot.json
}

let cryptoStore: ICryptoStorageProvider;
if (botConfig.MATRIX_ENCRYPTION) cryptoStore = new RustSdkCryptoStorageProvider(path.join(botConfig.DATA_PATH, "encrypted")); // /storage/encrypted

let cacheOptions: Keyv.Options<any>;  // Options for the Keyv cache, see https://www.npmjs.com/package/keyv
if (botConfig.KEYV_BACKEND === 'file'){
  cacheOptions = { store: new KeyvFile({ filename: path.join(botConfig.DATA_PATH, `chatgpt-bot-api.json`) })  };
} else {
  cacheOptions = { uri: botConfig.KEYV_URL }
}

async function main() {
  if (!botConfig.MATRIX_ACCESS_TOKEN){
    const botUsernameWithoutDomain = parseMatrixUsernamePretty(botConfig.MATRIX_BOT_USERNAME || "");
    const authedClient = await (new MatrixAuth(botConfig.MATRIX_HOMESERVER_URL)).passwordLogin(botUsernameWithoutDomain, botConfig.MATRIX_BOT_PASSWORD || "");
    console.log(authedClient.homeserverUrl + " token: \n" + authedClient.accessToken)
    console.log("Set MATRIX_ACCESS_TOKEN to above token, MATRIX_BOT_PASSWORD can now be blank")
    return;
  }
  if (!botConfig.MATRIX_THREADS && botConfig.CHATGPT_CONTEXT !== "room") throw Error("You must set CHATGPT_CONTEXT to 'room' if you set MATRIX_THREADS to false")
  const client: MatrixClient = new MatrixClient(botConfig.MATRIX_HOMESERVER_URL, botConfig.MATRIX_ACCESS_TOKEN, storage, cryptoStore);

  if (!botConfig.CHATGPT_API_MODEL) {
    LogService.warn("index", "This bot now uses the official API from ChatGPT. In order to migrate add the CHATGPT_API_MODEL variable to your .env");
    LogService.warn("index", "The official ChatGPT-model which should be used is 'gpt-3.5-turbo'. See the .env.example for details")
    LogService.warn("index", "Please note that the usage of the models charge your OpenAI account and are not free to use");
    return;
  }

  const clientOptions: ChatClientOptions = {
    modelId: botConfig.CHATGPT_API_MODEL,
    temperature: botConfig.CHATGPT_TEMPERATURE,
    systemMessage: botConfig.CHATGPT_PROMPT_PREFIX,
    // debug: false,
    // azure: OPENAI_AZURE,
    // maxContextTokens: CHATGPT_MAX_CONTEXT_TOKENS,
    maxInputTokens: botConfig.CHATGPT_MAX_PROMPT_TOKENS,
    maxCompletionTokens: botConfig.CHATGPT_MAX_RESPONSE_TOKENS,
    firstChunkSize: botConfig.MATRIX_FIRST_CHUNK_SIZE,
    useTwoChunksForFirstReply: botConfig.MATRIX_THREADS && botConfig.MATRIX_USE_TWO_CHUNKS_FOR_FIRST_REPLY,
  };


  let baseUrl = botConfig.CHATGPT_REVERSE_PROXY;
  const chatCompletionsSuffix = '/v1/chat/completions';
  if (baseUrl && baseUrl.endsWith(chatCompletionsSuffix)) {
    baseUrl = baseUrl.substring(0, baseUrl.length - chatCompletionsSuffix.length) + 'v1/'
  }

  const openai = new OpenAI({
    apiKey: botConfig.OPENAI_API_KEY,
    baseURL: baseUrl
  });

  const chatgpt = new ChatClient(openai, clientOptions, cacheOptions);

  // Automatically join rooms the bot is invited to
  if (botConfig.MATRIX_AUTOJOIN) AutojoinRoomsMixin.setupOnClient(client);

  client.on("room.failed_decryption", async (roomId, event, error) => {

    // todo: shortly after start sync this will be called for every failed room message if the keys has been reset.
    // the caller will not wait for the callback to complete, so ideally we have to implement producer-consumer here.
    // also we should not send text to the room with multiple decryption event errors.
    // for now we just ignore too old events and relying on their small count.

    if (Date.now() - event.origin_server_ts > 60000) {
      return;
    }

    LogService.warn(`Leaving room ${roomId} due to decryption error.`);

    await client.sendText(roomId, `Room key error. I will leave the room, please reinvite me!`);
    try {
      await client.leaveRoom(roomId);
    } catch (e) {
      LogService.error("index", `Failed to leave room ${roomId} after failed decryption!`);
    }
  });

  client.on("room.join", async (roomId: string, _event: any) => {
    LogService.info("index", `Bot joined room ${roomId}`);
    if(botConfig.MATRIX_WELCOME) {
      await client.sendMessage(roomId, {
        "msgtype": "m.notice",
        "body": `👋 Hello, I'm ChatGPT bot! Matrix E2EE: ${botConfig.MATRIX_ENCRYPTION}`,
      });
    }
  });

  // Prepare the command handler
  const commands = new CommandHandler(client, chatgpt);
  await commands.start();

  LogService.info("index", `Starting bot using ChatGPT model: ${botConfig.CHATGPT_API_MODEL}`);
  LogService.info("index", `Using system message: ${botConfig.CHATGPT_PROMPT_PREFIX}`)
  await client.start()
  LogService.info("index", "Bot started!");
}

main();
