CREATE TABLE `watchlist_return_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`strategy_decision_id` text NOT NULL,
	`token_radar_id` text,
	`mint_address` text NOT NULL,
	`pair_address` text,
	`symbol` text,
	`decision` text NOT NULL,
	`strategy_name` text NOT NULL,
	`strategy_score` integer,
	`horizon_minutes` integer NOT NULL,
	`baseline_observed_at_ms` integer NOT NULL,
	`baseline_price_sol` text,
	`baseline_price_usd` text,
	`baseline_liquidity_usd` text,
	`baseline_volume_5m_usd` text,
	`baseline_volume_1h_usd` text,
	`baseline_source` text NOT NULL,
	`due_at_ms` integer NOT NULL,
	`observed_at_ms` integer,
	`observed_price_sol` text,
	`observed_price_usd` text,
	`observed_liquidity_usd` text,
	`observed_volume_5m_usd` text,
	`observed_volume_1h_usd` text,
	`observed_source` text,
	`return_pct_sol` text,
	`return_pct_usd` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`error_code` text,
	`error_message` text,
	`raw_data_json` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`strategy_decision_id`) REFERENCES `strategy_decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_radar_id`) REFERENCES `token_radar`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_watchlist_returns_session_id` ON `watchlist_return_observations` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_watchlist_returns_mint_address` ON `watchlist_return_observations` (`mint_address`);--> statement-breakpoint
CREATE INDEX `idx_watchlist_returns_strategy_decision_id` ON `watchlist_return_observations` (`strategy_decision_id`);--> statement-breakpoint
CREATE INDEX `idx_watchlist_returns_status` ON `watchlist_return_observations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_watchlist_returns_due_at_ms` ON `watchlist_return_observations` (`due_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_watchlist_returns_horizon_minutes` ON `watchlist_return_observations` (`horizon_minutes`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_watchlist_returns_decision_horizon` ON `watchlist_return_observations` (`strategy_decision_id`,`horizon_minutes`);