import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * 1. 用户表 (Users)
 * 存储用户的基本账号信息
 */
export const customerConfigs = sqliteTable('customer_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  configHash: text('config_hash').notNull().unique(), // 唯一哈希，用于去重和关联
  jsonContent: text('json_content').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // 浏览器 Cookie 中的 Session ID 或 UUID
  customerConfigHash: text('customer_config_hash').references(() => customerConfigs.configHash),
  createdAt: integer('created_at').default(sql`CURRENT_TIMESTAMP`),
});

/**
 * 2. 订阅源表 (Upstream Subscriptions)
 * 存储用户添加的原始 Mihomo/Clash 订阅链接
 */
export const subscriptions = sqliteTable('subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }), // Auto-increment
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  lastHash: text('last_hash'),
  userInfo: text('user_info'),
  updatedAt: integer('updated_at'),
});

/**
 * 3. 转换配置表 (Transformed Configs)
 * 存储最终生成的 sing-box JSON 缓存
 */
export const singboxConfigs = sqliteTable('singbox_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }), // Auto-increment
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  jsonContent: text('json_content').notNull(),
  version: text('version').default('1.8.0'),
  createdAt: integer('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const draftConfigs = sqliteTable('draft_configs', {
  sessionId: text('session_id').primaryKey(), // Keep as text for URL identifiers
  jsonContent: text('json_content').notNull(),
  createdAt: integer('created_at').default(sql`CURRENT_TIMESTAMP`),
});
