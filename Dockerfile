# TAKT - Docker環境
# 他の環境でビルド・テストが動作するかを確認するため

# This image builds and tests the source, so it follows devEngines rather than
# the wider Node range supported by the published package.
FROM node:22.13.1-alpine

WORKDIR /app

# 依存関係のインストール（キャッシュ活用のため先にコピー）
COPY package.json package-lock.json ./
RUN npm ci

# ソースコードをコピー
COPY . .

# ビルド
RUN npm run build

# テスト実行
CMD ["npm", "run", "test"]
