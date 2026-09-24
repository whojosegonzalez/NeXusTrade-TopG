CREATE TABLE `sessions` (
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
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_mode` ON `sessions` (`mode`);--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at_ms` ON `sessions` (`started_at_ms`);--> statement-breakpoint
CREATE TABLE `token_radar` (
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
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_token_radar_session_id` ON `token_radar` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_token_radar_mint_address` ON `token_radar` (`mint_address`);--> statement-breakpoint
CREATE INDEX `idx_token_radar_status` ON `token_radar` (`status`);--> statement-breakpoint
CREATE INDEX `idx_token_radar_first_seen_at_ms` ON `token_radar` (`first_seen_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_token_radar_session_mint_source_pair` ON `token_radar` (`session_id`,`mint_address`,`source`,`pair_address`);--> statement-breakpoint
CREATE TABLE `risk_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`token_radar_id` text,
	`mint_address` text NOT NULL,
	`checked_at_ms` integer NOT NULL,
	`score` integer,
	`result` text DEFAULT 'UNKNOWN' NOT NULL,
	`passed` integer DEFAULT false NOT NULL,
	`mint_authority_disabled` integer,
	`freeze_authority_disabled` integer,
	`token_program` text,
	`top_holders_percent` text,
	`liquidity_usd` text,
	`risk_flags_json` text NOT NULL,
	`raw_provider_data_json` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_radar_id`) REFERENCES `token_radar`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_risk_assessments_session_id` ON `risk_assessments` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_risk_assessments_mint_address` ON `risk_assessments` (`mint_address`);--> statement-breakpoint
CREATE INDEX `idx_risk_assessments_result` ON `risk_assessments` (`result`);--> statement-breakpoint
CREATE INDEX `idx_risk_assessments_checked_at_ms` ON `risk_assessments` (`checked_at_ms`);--> statement-breakpoint
CREATE TABLE `strategy_decisions` (
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
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_strategy_decisions_session_id` ON `strategy_decisions` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_strategy_decisions_mint_address` ON `strategy_decisions` (`mint_address`);--> statement-breakpoint
CREATE INDEX `idx_strategy_decisions_decision` ON `strategy_decisions` (`decision`);--> statement-breakpoint
CREATE INDEX `idx_strategy_decisions_decided_at_ms` ON `strategy_decisions` (`decided_at_ms`);--> statement-breakpoint
CREATE TABLE `orders` (
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
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`strategy_decision_id`) REFERENCES `strategy_decisions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_orders_session_id` ON `orders` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_orders_mint_address` ON `orders` (`mint_address`);--> statement-breakpoint
CREATE INDEX `idx_orders_status` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `idx_orders_side` ON `orders` (`side`);--> statement-breakpoint
CREATE INDEX `idx_orders_created_at_ms` ON `orders` (`created_at_ms`);--> statement-breakpoint
CREATE TABLE `fills` (
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
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fills_order_id` ON `fills` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_fills_session_id` ON `fills` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_fills_filled_at_ms` ON `fills` (`filled_at_ms`);--> statement-breakpoint
CREATE TABLE `positions` (
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
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_positions_session_id` ON `positions` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_positions_mint_address` ON `positions` (`mint_address`);--> statement-breakpoint
CREATE INDEX `idx_positions_status` ON `positions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_positions_opened_at_ms` ON `positions` (`opened_at_ms`);--> statement-breakpoint
CREATE TABLE `position_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`position_id` text NOT NULL,
	`session_id` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`mark_price_sol` text,
	`sell_quote_lamports` integer,
	`unrealized_pnl_lamports` integer,
	`unrealized_pnl_bps` integer,
	`liquidity_usd` text,
	`raw_quote_json` text,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_position_snapshots_position_id` ON `position_snapshots` (`position_id`);--> statement-breakpoint
CREATE INDEX `idx_position_snapshots_session_id` ON `position_snapshots` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_position_snapshots_timestamp_ms` ON `position_snapshots` (`timestamp_ms`);--> statement-breakpoint
CREATE TABLE `equity_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`cash_lamports` integer NOT NULL,
	`open_position_value_lamports` integer NOT NULL,
	`total_equity_lamports` integer NOT NULL,
	`realized_pnl_lamports` integer NOT NULL,
	`unrealized_pnl_lamports` integer NOT NULL,
	`drawdown_lamports` integer,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_equity_snapshots_session_id` ON `equity_snapshots` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_equity_snapshots_timestamp_ms` ON `equity_snapshots` (`timestamp_ms`);--> statement-breakpoint
CREATE TABLE `system_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`timestamp_ms` integer NOT NULL,
	`level` text NOT NULL,
	`scope` text NOT NULL,
	`message` text NOT NULL,
	`context_json` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_system_logs_session_id` ON `system_logs` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_system_logs_timestamp_ms` ON `system_logs` (`timestamp_ms`);--> statement-breakpoint
CREATE INDEX `idx_system_logs_level` ON `system_logs` (`level`);--> statement-breakpoint
CREATE INDEX `idx_system_logs_scope` ON `system_logs` (`scope`);--> statement-breakpoint
CREATE TABLE `provider_health` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`provider` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`rate_limited` integer DEFAULT false NOT NULL,
	`error_message` text,
	`credits_used` integer,
	`context_json` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_provider_health_session_id` ON `provider_health` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_provider_health_provider` ON `provider_health` (`provider`);--> statement-breakpoint
CREATE INDEX `idx_provider_health_status` ON `provider_health` (`status`);--> statement-breakpoint
CREATE INDEX `idx_provider_health_timestamp_ms` ON `provider_health` (`timestamp_ms`);