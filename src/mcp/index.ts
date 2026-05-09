import { MCPServer } from './server.js';
import dotenv from 'dotenv';

// 環境変数読み込み
dotenv.config();

/**
 * MCP Server エントリーポイント
 * 
 * agent-hub を起動する
 * - HTTP トランスポートで複数クライアントを受け入れ
 * - X-User-Id ヘッダーで認証
 * - DB 接続を初期化してメッセージ・参加者を永続化
 */
async function main() {
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const server = new MCPServer(port);

  try {
    await server.start();
    console.log('✨ agent-hub is ready');
  } catch (error) {
    console.error('❌ Failed to start agent-hub:', error);
    process.exit(1);
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down agent-hub...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down agent-hub...');
    process.exit(0);
  });
}

// エラーハンドリング
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

main();
