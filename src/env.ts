import { parseEnv } from "znv";
import { z } from "zod";
import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

dotenvExpand.expand(dotenv.config({ override: true }));

export const botConfig = parseEnv(process.env, {
  DATA_PATH:                   { schema: z.string().default("./storage"),          description: "Set to /storage/ if using docker, ./storage if running without" },
  KEYV_BACKEND:                { schema: z.enum(["file", "other"]).default("file"),description: "Set the Keyv backend to 'file' or 'other' if other set KEYV_URL" },
  KEYV_URL:                    { schema: z.string().default(""),                   description: "Set Keyv backend for storage, in-memory if blank, ignored if KEYV_BACKEND set to `file`"},
  KEYV_BOT_STORAGE:            { schema: z.boolean().default(false),               description: "Set to true to use a Keyv backend to store bot data. Uses a file if false."},
  /** Matrix Bot Settings */
  MATRIX_HOMESERVER_URL:       { schema: z.string().default("https://matrix.org"), description: "Set matrix homeserver with 'https://' prefix" },
  MATRIX_ACCESS_TOKEN:         { schema: z.string().optional(),                    description: "Set MATRIX_BOT_USERNAME & MATRIX_BOT_PASSWORD to print MATRIX_ACCESS_TOKEN or follow https://webapps.stackexchange.com/questions/131056/how-to-get-an-access-token-for-element-riot-matrix" },
  MATRIX_BOT_USERNAME:         { schema: z.string().optional(),                    description: "Set full username: eg @bot:server.com (superseded by MATRIX_ACCESS_TOKEN if set)" },
  MATRIX_BOT_PASSWORD:         { schema: z.string().optional(),                    description: "Set password (superseded by MATRIX_ACCESS_TOKEN if set)" },
  /** Matrix Bot Features */
  MATRIX_AUTOJOIN:             { schema: z.boolean().default(true),                description: "Set to true if you want the bot to autojoin when invited" },
  MATRIX_ENCRYPTION:           { schema: z.boolean().default(true),                description: "Set to true if you want the bot to support encrypted channels" },
  MATRIX_THREADS:              { schema: z.boolean().default(true),                description: "Set to true if you want the bot to answer always in a new thread/conversation" },
  MATRIX_FIRST_CHUNK_SIZE:     { schema: z.number().optional(),                    description: "The size of the first flushed chunk (in chars) for each assistant response. If not set or 0, streaming will not be used." },
  MATRIX_USE_TWO_CHUNKS_FOR_FIRST_REPLY: { schema: z.boolean().default(false),     description: "Set true if your matrix client does not refreshes after the second edit of first thread answer (reproduces in Element 1.11.61)" },
  MATRIX_GENERATING_MESSAGE:   { schema: z.string().default("*...⚒️generating⚒️...*"), description: "String that will appear in the end of the message that is still generating." },
  MATRIX_UNEXPECTED_FINISH_REASON:{ schema: z.string().default("**❗UNEXPECTED FINISH REASON: {finishReason}.**"), description: "String that will appear in the end of the message that is finished by model with unexpected reason." },
  MATRIX_ADD_USAGE:            { schema: z.boolean().default(false),               description: "Adds usage information to the end of the message" },
  MATRIX_PREFIX_DM:            { schema: z.boolean().default(false),               description: "Set to false if you want the bot to answer to all messages in a one-to-one room" },
  MATRIX_RICH_TEXT:            { schema: z.boolean().default(true),                description: "Set to true if you want the bot to answer with enriched text" },
  MATRIX_WELCOME:              { schema: z.boolean().default(true),                description: "Set to true if you want the bot to post a message when it joins a new chat." },
  /** Matrix Access Control */
  MATRIX_BLACKLIST:            { schema: z.string().optional(),                    description: "Set to a spaces separated string of 'user:homeserver' or a wildcard like ':anotherhomeserver.example' to blacklist users or domains" },
  MATRIX_WHITELIST:            { schema: z.string().optional(),                    description: "Set to a spaces separated string of 'user:homeserver' or a wildcard like ':anotherhomeserver.example' to whitelist users or domains" },
  MATRIX_ROOM_BLACKLIST:       { schema: z.string().optional(),                    description: "Set to a spaces separated string of 'user:homeserver' or a wildcard like ':anotherhomeserver.example' to blacklist rooms or domains" },
  MATRIX_ROOM_WHITELIST:       { schema: z.string().optional(),                    description: "Set to a spaces separated string of 'user:homeserver' or a wildcard like ':anotherhomeserver.example' to whitelist rooms or domains" },
  /** Matrix Bot Runtime Config */
  MATRIX_DEFAULT_PREFIX:       { schema: z.string().default(""),                   description: "Set to a string if you want the bot to respond only when messages start with this prefix. Trailing space matters. Empty for no prefix." },
  MATRIX_DEFAULT_PREFIX_REPLY: { schema: z.boolean().default(false),               description: "Set to false if you want the bot to answer to all messages in a thread/conversation (this does not relates to message replies, only threads)" },
  /** ChatGPT Settings */
  OPENAI_AZURE:                { schema: z.boolean().default(false),               description: "Wether or not to use Azure OPENAI"},
  OPENAI_API_KEY:              { schema: z.string().default(""),                   description: "Set to the API key from https://platform.openai.com/account/api-keys"},
  CHATGPT_TIMEOUT:             { schema: z.number().default(2 * 60 * 1000),        description: "Set number of milliseconds to wait for ChatGPT responses" },
  CHATGPT_CONTEXT:             { schema: z.enum(["thread", "room", "both"]).default("thread"), description: "Set the ChatGPT conversation context to 'thread', 'room' or 'both'" },
  CHATGPT_API_MODEL:           { schema: z.string().default(""),                   description: "The model for the ChatGPT-API to use. Keep in mind that these models will charge your OpenAI account depending on their pricing." },
  CHATGPT_PROMPT_PREFIX:       { schema: z.string().default(""),                   description: "Chat first system message. Absent by default."},
  CHATGPT_REVERSE_PROXY:       { schema: z.string().default(""),                   description: "Change the api url to use another (OpenAI-compatible) API endpoint" },
  CHATGPT_TEMPERATURE:         { schema: z.number().default(1),                  description: "Set the temperature for the model" },
  CHATGPT_MAX_CONTEXT_TOKENS:  { schema: z.number().default(4097), description: "Davinci models have a max context length of 4097 tokens, but you may need to change this for other models." },
  CHATGPT_MAX_PROMPT_TOKENS:   { schema: z.number().default(3097), description: "You might want to lower this to save money if using a paid model. Earlier messages will be dropped until the prompt is within the limit." },
  CHATGPT_MAX_RESPONSE_TOKENS: { schema: z.number().default(2048), description: "Considers 'thinking' tokens. You might want to lower this to save money if using a paid model." },
  CHATGPT_PROMPT_TOKEN_COST:   { schema: z.number().optional(),    description: "$ cost per 1M prompt tokens, requires CHATGPT_RESPONSE_TOKEN_COST to be calculated" },
  CHATGPT_RESPONSE_TOKEN_COST: { schema: z.number().optional(),    description: "$ cost per 1M completion tokens, requires CHATGPT_PROMPT_TOKEN_COST to be calculated" },
  CHATGPT_ENABLE_VISION:       { schema: z.boolean().default(true), description: "Set to false to disable accepting images." },
});
