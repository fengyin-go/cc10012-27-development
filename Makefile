.PHONY: install frontend build test verify

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

test:
	cd frontend && npm run test

# 类型检查 + 缓存引擎测试 + 生产构建，与部署流水线保持同一道验证。
verify:
	cd frontend && npm run verify
