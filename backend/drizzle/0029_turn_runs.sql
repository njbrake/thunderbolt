-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "turn_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" text NOT NULL,
	"model_id" text NOT NULL,
	"prompt" text NOT NULL,
	"parent_message_id" text,
	"assistant_message_id" text NOT NULL,
	"state" text NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_runs" ADD CONSTRAINT "turn_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_turn_runs_user_id" ON "turn_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_turn_runs_state" ON "turn_runs" USING btree ("state");