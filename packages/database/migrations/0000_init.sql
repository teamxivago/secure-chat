CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocked_user" (
	"user_id" text NOT NULL,
	"blocked_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_user_user_id_blocked_user_id_pk" PRIMARY KEY("user_id","blocked_user_id")
);
--> statement-breakpoint
CREATE TABLE "call" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text,
	"initiator_id" text NOT NULL,
	"video" boolean DEFAULT false NOT NULL,
	"is_group" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ringing' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "call_participant" (
	"call_id" text NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text,
	"state" text DEFAULT 'invited' NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	CONSTRAINT "call_participant_call_id_user_id_pk" PRIMARY KEY("call_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "channel_post_view" (
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_post_view_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"username" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"avatar_media_id" text,
	"avatar_key" text,
	"created_by" text NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"slow_mode_seconds" integer DEFAULT 0 NOT NULL,
	"reactions_mode" text DEFAULT 'all' NOT NULL,
	"allowed_reactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"join_approval" boolean DEFAULT false NOT NULL,
	"sign_messages" boolean DEFAULT false NOT NULL,
	"hide_subscriber_count" boolean DEFAULT false NOT NULL,
	"linked_chat_id" text,
	"key_epoch" integer DEFAULT 0 NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "chat_ban" (
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"banned_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_ban_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_member" (
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"rights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_title" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_seq" bigint DEFAULT 0 NOT NULL,
	"last_post_at" timestamp with time zone,
	"invited_by" text,
	CONSTRAINT "chat_member_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"owner_id" text NOT NULL,
	"contact_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_owner_id_contact_user_id_pk" PRIMARY KEY("owner_id","contact_user_id")
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"registration_id" integer NOT NULL,
	"push_token" text,
	"push_platform" text,
	"voip_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_link" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"public_key" text NOT NULL,
	"ephemeral_key" text,
	"ciphertext" text,
	"approved_by" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "envelope" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recipient_device_id" text NOT NULL,
	"type" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"sealed" boolean DEFAULT true NOT NULL,
	"sender_user_id" text,
	"sender_device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_invite_link" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"token" text NOT NULL,
	"name" text,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"usage_limit" integer DEFAULT 0 NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_invite_link_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "group_join_request" (
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"invite_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	CONSTRAINT "group_join_request_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "group_message" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"sender_tag" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"kind" text DEFAULT 'message' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_key" (
	"device_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_preview" (
	"url_hash" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"object_key" text NOT NULL,
	"size" bigint NOT NULL,
	"part_size" integer,
	"upload_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"delete_token_hash" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"mode" text DEFAULT 'all' NOT NULL,
	"muted_until" timestamp with time zone,
	"sound" text,
	"vibrate" boolean DEFAULT true NOT NULL,
	CONSTRAINT "notification_preference_user_id_scope_pk" PRIMARY KEY("user_id","scope")
);
--> statement-breakpoint
CREATE TABLE "one_time_pre_key" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"key_id" integer NOT NULL,
	"public_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinned_message" (
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"pinned_by" text NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pinned_message_chat_id_message_id_pk" PRIMARY KEY("chat_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "report" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL,
	"target_user_id" text,
	"chat_id" text,
	"message_id" text,
	"reason" text NOT NULL,
	"disclosed_content" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sender_key_epoch" (
	"chat_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"reason" text NOT NULL,
	"rotated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sender_key_epoch_chat_id_epoch_pk" PRIMARY KEY("chat_id","epoch")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "signed_pre_key" (
	"device_id" text NOT NULL,
	"key_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signed_pre_key_device_id_key_id_pk" PRIMARY KEY("device_id","key_id")
);
--> statement-breakpoint
CREATE TABLE "sticker" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_id" text NOT NULL,
	"emoji" text NOT NULL,
	"mime" text NOT NULL,
	"url" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sticker_pack" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"animated" boolean DEFAULT false NOT NULL,
	"thumbnail_sticker_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sticker_pack_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" text,
	"display_username" text,
	"phone_number" text,
	"phone_number_verified" boolean DEFAULT false,
	"last_name" text,
	"bio" text,
	"avatar_media_id" text,
	"avatar_key" text,
	"emoji_status" text,
	"username_changed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"phone_visibility" text DEFAULT 'contacts' NOT NULL,
	"last_seen_visibility" text DEFAULT 'everyone' NOT NULL,
	"profile_photo_visibility" text DEFAULT 'everyone' NOT NULL,
	"phone_discoverable" boolean DEFAULT true NOT NULL,
	"discovery_token" text,
	"account_key_backup" text,
	"onboarded" boolean DEFAULT false NOT NULL,
	"notification_settings" jsonb,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username"),
	CONSTRAINT "user_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "user_sticker_pack" (
	"user_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sticker_pack_user_id_pack_id_pk" PRIMARY KEY("user_id","pack_id")
);
--> statement-breakpoint
CREATE TABLE "vault_record" (
	"user_id" text NOT NULL,
	"record_id" text NOT NULL,
	"kind" text NOT NULL,
	"data" text,
	"deleted" boolean DEFAULT false NOT NULL,
	"version" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_record_user_id_record_id_pk" PRIMARY KEY("user_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_user" ADD CONSTRAINT "blocked_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_user" ADD CONSTRAINT "blocked_user_blocked_user_id_user_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participant" ADD CONSTRAINT "call_participant_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_post_view" ADD CONSTRAINT "channel_post_view_message_id_group_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."group_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_ban" ADD CONSTRAINT "chat_ban_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_member" ADD CONSTRAINT "chat_member_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_member" ADD CONSTRAINT "chat_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_contact_user_id_user_id_fk" FOREIGN KEY ("contact_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_link" ADD CONSTRAINT "device_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_link" ADD CONSTRAINT "device_link_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope" ADD CONSTRAINT "envelope_recipient_device_id_device_id_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invite_link" ADD CONSTRAINT "group_invite_link_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_request" ADD CONSTRAINT "group_join_request_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_request" ADD CONSTRAINT "group_join_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_message" ADD CONSTRAINT "group_message_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_key" ADD CONSTRAINT "identity_key_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_pre_key" ADD CONSTRAINT "one_time_pre_key_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_message" ADD CONSTRAINT "pinned_message_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_key_epoch" ADD CONSTRAINT "sender_key_epoch_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_pre_key" ADD CONSTRAINT "signed_pre_key_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker" ADD CONSTRAINT "sticker_pack_id_sticker_pack_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."sticker_pack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sticker_pack" ADD CONSTRAINT "user_sticker_pack_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sticker_pack" ADD CONSTRAINT "user_sticker_pack_pack_id_sticker_pack_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."sticker_pack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_record" ADD CONSTRAINT "vault_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "call_chat_idx" ON "call" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "chat_public_idx" ON "chat" USING btree ("is_public","type");--> statement-breakpoint
CREATE INDEX "chat_member_user_idx" ON "chat_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contact_rev_idx" ON "contact" USING btree ("contact_user_id");--> statement-breakpoint
CREATE INDEX "device_user_idx" ON "device" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "envelope_recipient_idx" ON "envelope" USING btree ("recipient_device_id","id");--> statement-breakpoint
CREATE INDEX "invite_chat_idx" ON "group_invite_link" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_message_seq" ON "group_message" USING btree ("chat_id","seq");--> statement-breakpoint
CREATE INDEX "media_expiry_idx" ON "media" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "media_owner_idx" ON "media" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "otpk_device_key" ON "one_time_pre_key" USING btree ("device_id","key_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sticker_pack_idx" ON "sticker" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX "user_discovery_idx" ON "user" USING btree ("discovery_token");--> statement-breakpoint
CREATE INDEX "vault_version_idx" ON "vault_record" USING btree ("user_id","version");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");