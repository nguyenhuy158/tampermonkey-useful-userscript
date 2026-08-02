.PHONY: install test test-video clean help

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (pnpm) + Playwright Chromium
	pnpm install
	pnpm exec playwright install chromium

test: ## Run unit tests (node:test + jsdom)
	pnpm test

test-video: ## Run the video robot test (records test/video/out/*.webm)
	pnpm run test:video

clean: ## Remove node_modules and recorded videos
	rm -rf node_modules test/video/out
