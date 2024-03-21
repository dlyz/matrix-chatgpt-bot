import type { TextualMessageEventContent, ImageMessageEventContent, MessageEventContent } from "matrix-bot-sdk";

export type MessageContent = MessageEventContent & IContent & {
	"msgtype": MsgType,
};

export type TextMessageContent = TextualMessageEventContent & MessageContent & {
	"msgtype": "m.text",
};

export type ImageMessageContent = ImageMessageEventContent & MessageContent & {
	"msgtype": "m.image",
};

/// matrix-org/matrix-js-sdk/src/@types/membership.ts

/**
 * Well-known values (from the spec or MSCs) that are allowed in the
 * {@link Membership} type.
 */
export enum KnownMembership {
    /**
     * The user has been banned from the room, and is no longer allowed to join
     * it until they are un-banned from the room (by having their membership
     * state set to a value other than ban).
     */
    Ban = "ban",
    /**
     * The user has been invited to join a room, but has not yet joined it.
     * They may not participate in the room until they join.
     * */
    Invite = "invite",
    /**
     * The user has joined the room (possibly after accepting an invite), and
     * may participate in it.
     */
    Join = "join",
    /**
     * The user has knocked on the room, requesting permission to participate.
     * They may not participate in the room until they join.
     */
    Knock = "knock",
    /**
     * The user was once joined to the room, but has since left (possibly by
     * choice, or possibly by being kicked).
     */
    Leave = "leave",
}

/**
 * The membership state for a user in a room [1]. A value from
 * {@link KnownMembership} should be used where available, but all string values
 * are allowed to provide flexibility for upcoming spec changes or proposals.
 *
 * [1] https://spec.matrix.org/latest/client-server-api/#mroommember
 */
export type Membership = KnownMembership | string;


/// matrix-org/matrix-js-sdk/src/@types/event.ts

export type RelationType = never
    | "m.annotation"
    | "m.replace"
    | "m.reference"
    | "m.thread"
;

export type MsgType = never
    | "m.text"
    | "m.emote"
    | "m.notice"
    | "m.image"
    | "m.file"
    | "m.audio"
    | "m.location"
    | "m.video"
    | "m.key.verification.request"
;

export const RoomCreateTypeField = "type";

export enum RoomType {
    Space = "m.space",
    UnstableCall = "org.matrix.msc3417.call",
    ElementVideo = "io.element.video",
}

/// matrix-org/matrix-js-sdk/src/models/event.ts

/* eslint-disable camelcase */
export interface IContent {
    [key: string]: any;
    "msgtype"?: MsgType | string;
    "membership"?: Membership;
    "avatar_url"?: string;
    "displayname"?: string;
    "m.relates_to"?: IEventRelation;

    "m.mentions"?: IMentions;
}

type StrippedState = Required<Pick<IEvent, "content" | "state_key" | "type" | "sender">>;

export interface IUnsigned {
    [key: string]: any;
    "age"?: number;
    "prev_sender"?: string;
    "prev_content"?: IContent;
    "redacted_because"?: IEvent;
    "replaces_state"?: string;
    "transaction_id"?: string;
    "invite_room_state"?: StrippedState[];
    "m.relations"?: Record<RelationType | string, any>; // No common pattern for aggregated relations
    //[UNSIGNED_THREAD_ID_FIELD.name]?: string;
}

export interface IThreadBundledRelationship {
    latest_event: IEvent;
    count: number;
    current_user_participated?: boolean;
}

export interface IEvent {
    event_id: string;
    type: string;
    content: IContent;
    sender: string;
    room_id?: string;
    origin_server_ts: number;
    txn_id?: string;
    state_key?: string;
    membership?: Membership;
    unsigned: IUnsigned;
    redacts?: string;

    /**
     * @deprecated in favour of `sender`
     */
    user_id?: string;
    /**
     * @deprecated in favour of `unsigned.prev_content`
     */
    prev_content?: IContent;
    /**
     * @deprecated in favour of `origin_server_ts`
     */
    age?: number;
}

export interface IAggregatedRelation {
    origin_server_ts: number;
    event_id?: string;
    sender?: string;
    type?: string;
    count?: number;
    key?: string;
}

export interface IEventRelation {
    "rel_type"?: RelationType;
    "event_id"?: string;
    "is_falling_back"?: boolean;
    "m.in_reply_to"?: {
        event_id?: string;
    };
    "key"?: string;
}

export interface IMentions {
    user_ids?: string[];
    room?: boolean;
}

/**
 * When an event is a visibility change event, as per MSC3531,
 * the visibility change implied by the event.
 */
export interface IVisibilityChange {
    /**
     * If `true`, the target event should be made visible.
     * Otherwise, it should be hidden.
     */
    visible: boolean;

    /**
     * The event id affected.
     */
    eventId: string;

    /**
     * Optionally, a human-readable reason explaining why
     * the event was hidden. Ignored if the event was made
     * visible.
     */
    reason: string | null;
}

export interface IMarkedUnreadEvent {
    unread: boolean;
}

export interface IClearEvent {
    room_id?: string;
    type: string;
    content: Omit<IContent, "membership" | "avatar_url" | "displayname" | "m.relates_to">;
    unsigned?: IUnsigned;
}
/* eslint-enable camelcase */

interface IKeyRequestRecipient {
    userId: string;
    deviceId: "*" | string;
}

export interface IDecryptOptions {
    /** Whether to emit {@link MatrixEventEvent.Decrypted} events on successful decryption. Defaults to true.
     */
    emit?: boolean;

    /**
     * True if this is a retry, after receiving an update to the session key. (Enables more logging.)
     *
     * This is only intended for use within the js-sdk.
     *
     * @internal
     */
    isRetry?: boolean;

    /**
     * Whether the message should be re-decrypted if it was previously successfully decrypted with an untrusted key.
     * Defaults to `false`.
     */
    forceRedecryptIfUntrusted?: boolean;
}

/**
 * Message hiding, as specified by https://github.com/matrix-org/matrix-doc/pull/3531.
 */
export type MessageVisibility = IMessageVisibilityHidden | IMessageVisibilityVisible;
/**
 * Variant of `MessageVisibility` for the case in which the message should be displayed.
 */
export interface IMessageVisibilityVisible {
    readonly visible: true;
}
/**
 * Variant of `MessageVisibility` for the case in which the message should be hidden.
 */
export interface IMessageVisibilityHidden {
    readonly visible: false;
    /**
     * Optionally, a human-readable reason to show to the user indicating why the
     * message has been hidden (e.g. "Message Pending Moderation").
     */
    readonly reason: string | null;
}