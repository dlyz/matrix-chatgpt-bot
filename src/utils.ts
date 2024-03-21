import Markdown from 'markdown-it';
import { LogService, MatrixClient, MatrixError } from "matrix-bot-sdk";
import { TextMessageContent } from './matrixTypes.js';

const md = Markdown();

export function parseMatrixUsernamePretty(matrix_username: string): string {
  if (matrix_username.includes(":") === false || matrix_username.includes("@") === false) {
    return matrix_username;
  }
  const withoutUrl = matrix_username.split(':')[0];
  return withoutUrl.split('@')[1]
}

export function sendError(client: MatrixClient, text: string, roomId: string, eventId: string): Promise<any> {
  return Promise.all([
    client.setTyping(roomId, false, 500),
    client.sendText(roomId, text),
    client.sendReadReceipt(roomId, eventId)
  ]);
}


/**
 * Send a thread reply.
 */
export async function sendReply({client, roomId, rootEventId, text, rich, editingEventId}: {
  client: MatrixClient,
  roomId: string,
  rootEventId?: string,
  editingEventId?: string
  text: string,
  rich: boolean
}): Promise<string> {

  const content: TextMessageContent = {
    msgtype: "m.text",
    body: text,
  }

  if (rich) {
    const renderedText = md.render(text)
    Object.assign<TextMessageContent, Partial<TextMessageContent>>(content, {
      format: "org.matrix.custom.html",
      formatted_body: renderedText,
    })
  }

  if (editingEventId) {

    Object.assign<TextMessageContent, Partial<TextMessageContent>>(content, {
      "m.new_content": JSON.parse(JSON.stringify(content)),
      "m.relates_to": {
        "rel_type": "m.replace",
        "event_id": editingEventId,
        is_falling_back: true,
      }
    })

  } else if (rootEventId) {
    Object.assign<TextMessageContent, Partial<TextMessageContent>>(content, {
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: rootEventId,
        is_falling_back: true,
        "m.in_reply_to": {
          "event_id": rootEventId
        },
      }
    })

  }


  // todo: retries to all client methods. or move to official sdk client
  try {
    return await client.sendMessage(roomId, content);
  } catch (e) {
    if (e instanceof MatrixError && e.errcode === 'M_LIMIT_EXCEEDED' && e.retryAfterMs) {
      LogService.warn(`Matrix sendEvent error: ${e.errcode} ${e.error}, retry after: ${e.retryAfterMs}ms`);
      await delay(Math.min(e.retryAfterMs, 10*1000));
      return await client.sendMessage(roomId, content);
    } else {
      throw e;
    }
  }
}




export function delay(milliseconds: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, milliseconds);
		});
}
