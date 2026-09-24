CREATE TABLE `paper_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`mode` text DEFAULT 'PAPER' NOT NULL,
	`session_id` text NOT NULL,
	`side` text NOT NULL,
	`source_id` text NOT NULL,
	`mint_address` text NOT NULL,
	`strategy_decision_id` text,
	`input_position_id` text,
	`radar_id` text,
	`intent_digest` text NOT NULL,
	`intent_json` text NOT NULL,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`order_id` text,
	`fill_id` text,
	`result_position_id` text,
	`result_json` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`,`mode`) REFERENCES `sessions`(`id`,`mode`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`strategy_decision_id`,`session_id`) REFERENCES `strategy_decisions`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`input_position_id`,`session_id`) REFERENCES `positions`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`radar_id`,`session_id`) REFERENCES `token_radar`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`,`session_id`) REFERENCES `orders`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fill_id`,`session_id`) REFERENCES `fills`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_position_id`,`session_id`) REFERENCES `positions`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "h2_operations_mode" CHECK("paper_operations"."mode" = 'PAPER'),
	CONSTRAINT "h2_operations_side" CHECK("paper_operations"."side" IN ('BUY', 'SELL')),
	CONSTRAINT "h2_operations_state" CHECK("paper_operations"."state" IN ('PENDING', 'COMMITTED', 'REJECTED')),
	CONSTRAINT "h2_operations_version" CHECK("paper_operations"."version" = 1),
	CONSTRAINT "h2_operations_digest" CHECK(length("paper_operations"."intent_digest") = 64 AND "paper_operations"."intent_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "h2_operations_intent_json" CHECK(json_valid("paper_operations"."intent_json") AND json_type("paper_operations"."intent_json") = 'object'),
	CONSTRAINT "h2_operations_source" CHECK(("paper_operations"."side" = 'BUY' AND "paper_operations"."strategy_decision_id" IS NOT NULL AND "paper_operations"."source_id" = "paper_operations"."strategy_decision_id" AND "paper_operations"."radar_id" IS NOT NULL AND "paper_operations"."input_position_id" IS NULL) OR ("paper_operations"."side" = 'SELL' AND "paper_operations"."input_position_id" IS NOT NULL AND "paper_operations"."source_id" = "paper_operations"."input_position_id" AND "paper_operations"."strategy_decision_id" IS NULL)),
	CONSTRAINT "h2_operations_result" CHECK(("paper_operations"."state" = 'PENDING' AND "paper_operations"."order_id" IS NULL AND "paper_operations"."fill_id" IS NULL AND "paper_operations"."result_position_id" IS NULL AND "paper_operations"."result_json" IS NULL) OR ("paper_operations"."state" = 'REJECTED' AND "paper_operations"."order_id" IS NOT NULL AND "paper_operations"."fill_id" IS NULL AND "paper_operations"."result_position_id" IS NULL AND "paper_operations"."result_json" IS NOT NULL AND json_valid("paper_operations"."result_json") AND json_type("paper_operations"."result_json") = 'object') OR ("paper_operations"."state" = 'COMMITTED' AND "paper_operations"."order_id" IS NOT NULL AND "paper_operations"."fill_id" IS NOT NULL AND "paper_operations"."result_position_id" IS NOT NULL AND "paper_operations"."result_json" IS NOT NULL AND json_valid("paper_operations"."result_json") AND json_type("paper_operations"."result_json") = 'object')),
	CONSTRAINT "h2_operations_created_at_ms" CHECK("paper_operations"."created_at_ms" IS NULL OR (typeof("paper_operations"."created_at_ms") = 'integer' AND "paper_operations"."created_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_operations_updated_at_ms" CHECK("paper_operations"."updated_at_ms" IS NULL OR (typeof("paper_operations"."updated_at_ms") = 'integer' AND "paper_operations"."updated_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_operations_time_order" CHECK("paper_operations"."updated_at_ms" >= "paper_operations"."created_at_ms")
);

--> statement-breakpoint
CREATE UNIQUE INDEX `h2_operations_owner` ON `paper_operations` (`id`,`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_operations_order` ON `paper_operations` (`order_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_operations_fill` ON `paper_operations` (`fill_id`);
--> statement-breakpoint
CREATE TABLE `__new_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`mode` text NOT NULL,
	`side` text NOT NULL,
	`mint_address` text NOT NULL,
	`status` text DEFAULT 'CREATED' NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`requested_sol_lamports` integer,
	`requested_token_amount` text,
	`quote_source` text,
	`quote_id` text,
	`strategy_decision_id` text,
	`reason` text,
	`raw_order_json` text,
	`operation_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`strategy_decision_id`) REFERENCES `strategy_decisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`operation_id`) REFERENCES `paper_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`,`mode`) REFERENCES `sessions`(`id`,`mode`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`strategy_decision_id`,`session_id`) REFERENCES `strategy_decisions`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`,`session_id`) REFERENCES `paper_operations`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "h2_orders_mode" CHECK("__new_orders"."mode" IN ('PAPER', 'LIVE', 'BACKTEST')),
	CONSTRAINT "h2_orders_side" CHECK("__new_orders"."side" IN ('BUY', 'SELL')),
	CONSTRAINT "h2_orders_status" CHECK("__new_orders"."status" IN ('CREATED', 'QUOTED', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "h2_orders_created_at_ms" CHECK("__new_orders"."created_at_ms" IS NULL OR (typeof("__new_orders"."created_at_ms") = 'integer' AND "__new_orders"."created_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_orders_updated_at_ms" CHECK("__new_orders"."updated_at_ms" IS NULL OR (typeof("__new_orders"."updated_at_ms") = 'integer' AND "__new_orders"."updated_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_orders_requested_sol_lamports" CHECK("__new_orders"."requested_sol_lamports" IS NULL OR (typeof("__new_orders"."requested_sol_lamports") = 'integer' AND "__new_orders"."requested_sol_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_orders_time_order" CHECK("__new_orders"."updated_at_ms" >= "__new_orders"."created_at_ms"),
	CONSTRAINT "h2_orders_operation_mode" CHECK("__new_orders"."operation_id" IS NULL OR "__new_orders"."mode" = 'PAPER')
);

--> statement-breakpoint
INSERT INTO `__new_orders`("id", "session_id", "mode", "side", "mint_address", "status", "created_at_ms", "updated_at_ms", "requested_sol_lamports", "requested_token_amount", "quote_source", "quote_id", "strategy_decision_id", "reason", "raw_order_json", "operation_id") SELECT "id", "session_id", "mode", "side", "mint_address", "status", "created_at_ms", "updated_at_ms", "requested_sol_lamports", "requested_token_amount", "quote_source", "quote_id", "strategy_decision_id", "reason", "raw_order_json", NULL FROM `orders`;
--> statement-breakpoint
DROP TABLE `orders`;
--> statement-breakpoint
ALTER TABLE `__new_orders` RENAME TO `orders`;
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_orders_owner` ON `orders` (`id`,`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_orders_operation` ON `orders` (`operation_id`);
--> statement-breakpoint
CREATE INDEX `idx_orders_session_id` ON `orders` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_orders_mint_address` ON `orders` (`mint_address`);
--> statement-breakpoint
CREATE INDEX `idx_orders_status` ON `orders` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_orders_side` ON `orders` (`side`);
--> statement-breakpoint
CREATE INDEX `idx_orders_created_at_ms` ON `orders` (`created_at_ms`);
--> statement-breakpoint
CREATE TABLE `__new_fills` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`session_id` text NOT NULL,
	`filled_at_ms` integer NOT NULL,
	`fill_price_sol` text,
	`fill_price_usd` text,
	`tokens_filled` text,
	`sol_spent_lamports` integer,
	`sol_received_lamports` integer,
	`estimated_base_fee_lamports` integer DEFAULT 0 NOT NULL,
	`estimated_priority_fee_lamports` integer DEFAULT 0 NOT NULL,
	`estimated_slippage_lamports` integer DEFAULT 0 NOT NULL,
	`price_impact_bps` integer,
	`quote_source` text,
	`raw_quote_json` text,
	`created_at_ms` integer NOT NULL,
	`operation_id` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `paper_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`,`session_id`) REFERENCES `orders`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`,`session_id`) REFERENCES `paper_operations`(`id`,`session_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "h2_fills_filled_at_ms" CHECK("__new_fills"."filled_at_ms" IS NULL OR (typeof("__new_fills"."filled_at_ms") = 'integer' AND "__new_fills"."filled_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_fills_created_at_ms" CHECK("__new_fills"."created_at_ms" IS NULL OR (typeof("__new_fills"."created_at_ms") = 'integer' AND "__new_fills"."created_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_fills_sol_spent_lamports" CHECK("__new_fills"."sol_spent_lamports" IS NULL OR (typeof("__new_fills"."sol_spent_lamports") = 'integer' AND "__new_fills"."sol_spent_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_fills_sol_received_lamports" CHECK("__new_fills"."sol_received_lamports" IS NULL OR (typeof("__new_fills"."sol_received_lamports") = 'integer' AND "__new_fills"."sol_received_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_fills_estimated_base_fee_lamports" CHECK("__new_fills"."estimated_base_fee_lamports" IS NULL OR (typeof("__new_fills"."estimated_base_fee_lamports") = 'integer' AND "__new_fills"."estimated_base_fee_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_fills_estimated_priority_fee_lamports" CHECK("__new_fills"."estimated_priority_fee_lamports" IS NULL OR (typeof("__new_fills"."estimated_priority_fee_lamports") = 'integer' AND "__new_fills"."estimated_priority_fee_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_fills_estimated_slippage_lamports" CHECK("__new_fills"."estimated_slippage_lamports" IS NULL OR (typeof("__new_fills"."estimated_slippage_lamports") = 'integer' AND "__new_fills"."estimated_slippage_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_fills_price_impact_bps" CHECK("__new_fills"."price_impact_bps" IS NULL OR (typeof("__new_fills"."price_impact_bps") = 'integer' AND "__new_fills"."price_impact_bps" BETWEEN -9007199254740991 AND 9007199254740991))
);

--> statement-breakpoint
INSERT INTO `__new_fills`("id", "order_id", "session_id", "filled_at_ms", "fill_price_sol", "fill_price_usd", "tokens_filled", "sol_spent_lamports", "sol_received_lamports", "estimated_base_fee_lamports", "estimated_priority_fee_lamports", "estimated_slippage_lamports", "price_impact_bps", "quote_source", "raw_quote_json", "created_at_ms", "operation_id") SELECT "id", "order_id", "session_id", "filled_at_ms", "fill_price_sol", "fill_price_usd", "tokens_filled", "sol_spent_lamports", "sol_received_lamports", "estimated_base_fee_lamports", "estimated_priority_fee_lamports", "estimated_slippage_lamports", "price_impact_bps", "quote_source", "raw_quote_json", "created_at_ms", NULL FROM `fills`;
--> statement-breakpoint
DROP TABLE `fills`;
--> statement-breakpoint
ALTER TABLE `__new_fills` RENAME TO `fills`;
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_fills_owner` ON `fills` (`id`,`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_fills_operation` ON `fills` (`operation_id`);
--> statement-breakpoint
CREATE INDEX `idx_fills_order_id` ON `fills` (`order_id`);
--> statement-breakpoint
CREATE INDEX `idx_fills_session_id` ON `fills` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_fills_filled_at_ms` ON `fills` (`filled_at_ms`);
--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'CREATED' NOT NULL,
	`started_at_ms` integer NOT NULL,
	`ended_at_ms` integer,
	`starting_balance_lamports` integer NOT NULL,
	`current_cash_lamports` integer NOT NULL,
	`target_profit_lamports` integer,
	`target_profit_bps` integer,
	`max_drawdown_lamports` integer,
	`realized_pnl_lamports` integer DEFAULT 0 NOT NULL,
	`unrealized_pnl_lamports` integer DEFAULT 0 NOT NULL,
	`termination_reason` text DEFAULT 'NOT_TERMINATED' NOT NULL,
	`config_snapshot_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "h2_sessions_mode" CHECK("__new_sessions"."mode" IN ('PAPER', 'LIVE', 'BACKTEST')),
	CONSTRAINT "h2_sessions_status" CHECK("__new_sessions"."status" IN ('CREATED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "h2_sessions_termination" CHECK("__new_sessions"."termination_reason" IN ('TARGET_REACHED', 'MAX_DRAWDOWN', 'DURATION_EXPIRED', 'USER_STOP', 'ENGINE_ERROR', 'NOT_TERMINATED')),
	CONSTRAINT "h2_sessions_started_at_ms" CHECK("__new_sessions"."started_at_ms" IS NULL OR (typeof("__new_sessions"."started_at_ms") = 'integer' AND "__new_sessions"."started_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_ended_at_ms" CHECK("__new_sessions"."ended_at_ms" IS NULL OR (typeof("__new_sessions"."ended_at_ms") = 'integer' AND "__new_sessions"."ended_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_created_at_ms" CHECK("__new_sessions"."created_at_ms" IS NULL OR (typeof("__new_sessions"."created_at_ms") = 'integer' AND "__new_sessions"."created_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_updated_at_ms" CHECK("__new_sessions"."updated_at_ms" IS NULL OR (typeof("__new_sessions"."updated_at_ms") = 'integer' AND "__new_sessions"."updated_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_starting_balance_lamports" CHECK("__new_sessions"."starting_balance_lamports" IS NULL OR (typeof("__new_sessions"."starting_balance_lamports") = 'integer' AND "__new_sessions"."starting_balance_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_current_cash_lamports" CHECK("__new_sessions"."current_cash_lamports" IS NULL OR (typeof("__new_sessions"."current_cash_lamports") = 'integer' AND "__new_sessions"."current_cash_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_target_profit_lamports" CHECK("__new_sessions"."target_profit_lamports" IS NULL OR (typeof("__new_sessions"."target_profit_lamports") = 'integer' AND "__new_sessions"."target_profit_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_target_profit_bps" CHECK("__new_sessions"."target_profit_bps" IS NULL OR (typeof("__new_sessions"."target_profit_bps") = 'integer' AND "__new_sessions"."target_profit_bps" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_max_drawdown_lamports" CHECK("__new_sessions"."max_drawdown_lamports" IS NULL OR (typeof("__new_sessions"."max_drawdown_lamports") = 'integer' AND "__new_sessions"."max_drawdown_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_realized_pnl_lamports" CHECK("__new_sessions"."realized_pnl_lamports" IS NULL OR (typeof("__new_sessions"."realized_pnl_lamports") = 'integer' AND "__new_sessions"."realized_pnl_lamports" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_unrealized_pnl_lamports" CHECK("__new_sessions"."unrealized_pnl_lamports" IS NULL OR (typeof("__new_sessions"."unrealized_pnl_lamports") = 'integer' AND "__new_sessions"."unrealized_pnl_lamports" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "h2_sessions_time_order" CHECK("__new_sessions"."updated_at_ms" >= "__new_sessions"."created_at_ms" AND ("__new_sessions"."ended_at_ms" IS NULL OR "__new_sessions"."ended_at_ms" >= "__new_sessions"."started_at_ms"))
);

--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "mode", "status", "started_at_ms", "ended_at_ms", "starting_balance_lamports", "current_cash_lamports", "target_profit_lamports", "target_profit_bps", "max_drawdown_lamports", "realized_pnl_lamports", "unrealized_pnl_lamports", "termination_reason", "config_snapshot_json", "created_at_ms", "updated_at_ms") SELECT "id", "mode", "status", "started_at_ms", "ended_at_ms", "starting_balance_lamports", "current_cash_lamports", "target_profit_lamports", "target_profit_bps", "max_drawdown_lamports", "realized_pnl_lamports", "unrealized_pnl_lamports", "termination_reason", "config_snapshot_json", "created_at_ms", "updated_at_ms" FROM `sessions`;
--> statement-breakpoint
DROP TABLE `sessions`;
--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_sessions_owner_mode` ON `sessions` (`id`,`mode`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_mode` ON `sessions` (`mode`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at_ms` ON `sessions` (`started_at_ms`);
--> statement-breakpoint
CREATE TABLE `__new_token_radar` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`mint_address` text NOT NULL,
	`symbol` text,
	`name` text,
	`pair_address` text,
	`source` text NOT NULL,
	`first_seen_at_ms` integer NOT NULL,
	`discovered_at_ms` integer NOT NULL,
	`price_usd` text,
	`price_sol` text,
	`liquidity_usd` text,
	`volume_5m_usd` text,
	`volume_1h_usd` text,
	`age_seconds` integer,
	`status` text DEFAULT 'DISCOVERED' NOT NULL,
	`notes` text,
	`raw_data_json` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "h2_radar_status" CHECK("__new_token_radar"."status" IN ('DISCOVERED', 'WATCHING', 'REJECTED', 'APPROVED', 'BOUGHT', 'IGNORED', 'ERROR')),
	CONSTRAINT "h2_radar_pair" CHECK("__new_token_radar"."pair_address" IS NULL OR length(trim("__new_token_radar"."pair_address")) > 0),
	CONSTRAINT "h2_radar_first_seen_at_ms" CHECK("__new_token_radar"."first_seen_at_ms" IS NULL OR (typeof("__new_token_radar"."first_seen_at_ms") = 'integer' AND "__new_token_radar"."first_seen_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_radar_discovered_at_ms" CHECK("__new_token_radar"."discovered_at_ms" IS NULL OR (typeof("__new_token_radar"."discovered_at_ms") = 'integer' AND "__new_token_radar"."discovered_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_radar_created_at_ms" CHECK("__new_token_radar"."created_at_ms" IS NULL OR (typeof("__new_token_radar"."created_at_ms") = 'integer' AND "__new_token_radar"."created_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_radar_updated_at_ms" CHECK("__new_token_radar"."updated_at_ms" IS NULL OR (typeof("__new_token_radar"."updated_at_ms") = 'integer' AND "__new_token_radar"."updated_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_radar_age_seconds" CHECK("__new_token_radar"."age_seconds" IS NULL OR (typeof("__new_token_radar"."age_seconds") = 'integer' AND "__new_token_radar"."age_seconds" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_radar_time_order" CHECK("__new_token_radar"."updated_at_ms" >= "__new_token_radar"."created_at_ms")
);

--> statement-breakpoint
INSERT INTO `__new_token_radar`("id", "session_id", "mint_address", "symbol", "name", "pair_address", "source", "first_seen_at_ms", "discovered_at_ms", "price_usd", "price_sol", "liquidity_usd", "volume_5m_usd", "volume_1h_usd", "age_seconds", "status", "notes", "raw_data_json", "created_at_ms", "updated_at_ms") SELECT "id", "session_id", "mint_address", "symbol", "name", "pair_address", "source", "first_seen_at_ms", "discovered_at_ms", "price_usd", "price_sol", "liquidity_usd", "volume_5m_usd", "volume_1h_usd", "age_seconds", "status", "notes", "raw_data_json", "created_at_ms", "updated_at_ms" FROM `token_radar`;
--> statement-breakpoint
DROP TABLE `token_radar`;
--> statement-breakpoint
ALTER TABLE `__new_token_radar` RENAME TO `token_radar`;
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_radar_owner` ON `token_radar` (`id`,`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_radar_null_pair` ON `token_radar` (`session_id`,`mint_address`,`source`) WHERE "token_radar"."pair_address" IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_token_radar_session_id` ON `token_radar` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_token_radar_mint_address` ON `token_radar` (`mint_address`);
--> statement-breakpoint
CREATE INDEX `idx_token_radar_status` ON `token_radar` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_token_radar_first_seen_at_ms` ON `token_radar` (`first_seen_at_ms`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_token_radar_session_mint_source_pair` ON `token_radar` (`session_id`,`mint_address`,`source`,`pair_address`);
--> statement-breakpoint
CREATE TABLE `__new_strategy_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`mint_address` text NOT NULL,
	`decided_at_ms` integer NOT NULL,
	`decision` text NOT NULL,
	`strategy_name` text NOT NULL,
	`score` integer,
	`reason` text NOT NULL,
	`input_snapshot_json` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "h2_decisions_decision" CHECK("__new_strategy_decisions"."decision" IN ('WATCH', 'SKIP', 'BUY', 'HOLD', 'SELL')),
	CONSTRAINT "h2_decisions_created_at_ms" CHECK("__new_strategy_decisions"."created_at_ms" IS NULL OR (typeof("__new_strategy_decisions"."created_at_ms") = 'integer' AND "__new_strategy_decisions"."created_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_decisions_decided_at_ms" CHECK("__new_strategy_decisions"."decided_at_ms" IS NULL OR (typeof("__new_strategy_decisions"."decided_at_ms") = 'integer' AND "__new_strategy_decisions"."decided_at_ms" BETWEEN 0 AND 9007199254740991))
);

--> statement-breakpoint
INSERT INTO `__new_strategy_decisions`("id", "session_id", "mint_address", "decided_at_ms", "decision", "strategy_name", "score", "reason", "input_snapshot_json", "created_at_ms") SELECT "id", "session_id", "mint_address", "decided_at_ms", "decision", "strategy_name", "score", "reason", "input_snapshot_json", "created_at_ms" FROM `strategy_decisions`;
--> statement-breakpoint
DROP TABLE `strategy_decisions`;
--> statement-breakpoint
ALTER TABLE `__new_strategy_decisions` RENAME TO `strategy_decisions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_decisions_owner` ON `strategy_decisions` (`id`,`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_strategy_decisions_session_id` ON `strategy_decisions` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_strategy_decisions_mint_address` ON `strategy_decisions` (`mint_address`);
--> statement-breakpoint
CREATE INDEX `idx_strategy_decisions_decision` ON `strategy_decisions` (`decision`);
--> statement-breakpoint
CREATE INDEX `idx_strategy_decisions_decided_at_ms` ON `strategy_decisions` (`decided_at_ms`);
--> statement-breakpoint
CREATE TABLE `__new_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`mint_address` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`opened_at_ms` integer NOT NULL,
	`closed_at_ms` integer,
	`avg_entry_price_sol` text,
	`avg_exit_price_sol` text,
	`tokens_held` text NOT NULL,
	`cost_basis_lamports` integer DEFAULT 0 NOT NULL,
	`proceeds_lamports` integer DEFAULT 0 NOT NULL,
	`realized_pnl_lamports` integer DEFAULT 0 NOT NULL,
	`realized_pnl_bps` integer,
	`fees_paid_lamports` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "h2_positions_status" CHECK("__new_positions"."status" IN ('OPEN', 'CLOSING', 'CLOSED', 'ERROR')),
	CONSTRAINT "h2_positions_opened_at_ms" CHECK("__new_positions"."opened_at_ms" IS NULL OR (typeof("__new_positions"."opened_at_ms") = 'integer' AND "__new_positions"."opened_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_positions_closed_at_ms" CHECK("__new_positions"."closed_at_ms" IS NULL OR (typeof("__new_positions"."closed_at_ms") = 'integer' AND "__new_positions"."closed_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_positions_created_at_ms" CHECK("__new_positions"."created_at_ms" IS NULL OR (typeof("__new_positions"."created_at_ms") = 'integer' AND "__new_positions"."created_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_positions_updated_at_ms" CHECK("__new_positions"."updated_at_ms" IS NULL OR (typeof("__new_positions"."updated_at_ms") = 'integer' AND "__new_positions"."updated_at_ms" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_positions_cost_basis_lamports" CHECK("__new_positions"."cost_basis_lamports" IS NULL OR (typeof("__new_positions"."cost_basis_lamports") = 'integer' AND "__new_positions"."cost_basis_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_positions_proceeds_lamports" CHECK("__new_positions"."proceeds_lamports" IS NULL OR (typeof("__new_positions"."proceeds_lamports") = 'integer' AND "__new_positions"."proceeds_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_positions_fees_paid_lamports" CHECK("__new_positions"."fees_paid_lamports" IS NULL OR (typeof("__new_positions"."fees_paid_lamports") = 'integer' AND "__new_positions"."fees_paid_lamports" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "h2_positions_realized_pnl_lamports" CHECK("__new_positions"."realized_pnl_lamports" IS NULL OR (typeof("__new_positions"."realized_pnl_lamports") = 'integer' AND "__new_positions"."realized_pnl_lamports" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "h2_positions_realized_pnl_bps" CHECK("__new_positions"."realized_pnl_bps" IS NULL OR (typeof("__new_positions"."realized_pnl_bps") = 'integer' AND "__new_positions"."realized_pnl_bps" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "h2_positions_time_order" CHECK("__new_positions"."updated_at_ms" >= "__new_positions"."created_at_ms" AND ("__new_positions"."closed_at_ms" IS NULL OR "__new_positions"."closed_at_ms" >= "__new_positions"."opened_at_ms"))
);

--> statement-breakpoint
INSERT INTO `__new_positions`("id", "session_id", "mint_address", "status", "opened_at_ms", "closed_at_ms", "avg_entry_price_sol", "avg_exit_price_sol", "tokens_held", "cost_basis_lamports", "proceeds_lamports", "realized_pnl_lamports", "realized_pnl_bps", "fees_paid_lamports", "created_at_ms", "updated_at_ms") SELECT "id", "session_id", "mint_address", "status", "opened_at_ms", "closed_at_ms", "avg_entry_price_sol", "avg_exit_price_sol", "tokens_held", "cost_basis_lamports", "proceeds_lamports", "realized_pnl_lamports", "realized_pnl_bps", "fees_paid_lamports", "created_at_ms", "updated_at_ms" FROM `positions`;
--> statement-breakpoint
DROP TABLE `positions`;
--> statement-breakpoint
ALTER TABLE `__new_positions` RENAME TO `positions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_positions_owner` ON `positions` (`id`,`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `h2_positions_active_mint` ON `positions` (`session_id`,`mint_address`) WHERE "positions"."status" IN ('OPEN', 'CLOSING');
--> statement-breakpoint
CREATE INDEX `idx_positions_session_id` ON `positions` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_positions_mint_address` ON `positions` (`mint_address`);
--> statement-breakpoint
CREATE INDEX `idx_positions_status` ON `positions` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_positions_opened_at_ms` ON `positions` (`opened_at_ms`);
--> statement-breakpoint
CREATE TRIGGER h2_operations_immutable_intent BEFORE UPDATE ON paper_operations
WHEN NEW.id IS NOT OLD.id OR NEW.version IS NOT OLD.version OR NEW.mode IS NOT OLD.mode
 OR NEW.session_id IS NOT OLD.session_id OR NEW.side IS NOT OLD.side OR NEW.source_id IS NOT OLD.source_id
 OR NEW.mint_address IS NOT OLD.mint_address OR NEW.strategy_decision_id IS NOT OLD.strategy_decision_id
 OR NEW.input_position_id IS NOT OLD.input_position_id OR NEW.radar_id IS NOT OLD.radar_id
 OR NEW.intent_digest IS NOT OLD.intent_digest OR NEW.intent_json IS NOT OLD.intent_json
 OR NEW.created_at_ms IS NOT OLD.created_at_ms OR OLD.state != 'PENDING'
BEGIN SELECT RAISE(ABORT, 'PAPER_OPERATION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER h2_operations_no_delete BEFORE DELETE ON paper_operations
BEGIN SELECT RAISE(ABORT, 'PAPER_OPERATION_IMMUTABLE'); END;
