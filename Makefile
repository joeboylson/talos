.PHONY: dev down logs desktop talos screenshots server-image install typecheck test

# AWS Graviton (arm64) is cheaper than x86 and matches Apple silicon.
SERVER_PLATFORM ?= linux/arm64

# Starts the AWS emulator and talos-server in Docker, then runs talos here.
# Ctrl-C stops talos; `make down` stops the rest.
dev: node_modules .env
	docker compose up --build --detach --wait
	cd talos && bun run dev

down:
	docker compose down

logs:
	docker compose logs --follow talos-server

# Opens the desktop app on the server's page. Run `make dev` first.
desktop: node_modules .env
	cd talos-desktop && bun run dev

# `make talos <command>` runs any talos command from here, like
# `make talos folders add ~/code/x`. Plain `make talos`
# connects (and restarts on each save), for when the server is already up.
# The words after `talos` would otherwise be read as make targets, so they're
# turned into targets that do nothing.
ifeq (talos,$(firstword $(MAKECMDGOALS)))
  TALOS_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
  $(eval $(TALOS_ARGS):;@:)
endif

talos: node_modules .env
ifeq ($(TALOS_ARGS),)
	cd talos && bun run dev
else
	@bun --env-file=.env talos/src/index.ts $(TALOS_ARGS)
endif

# Retakes every screen of the page into docs/screenshots/, under fixed names,
# from a throwaway server with made-up data (its own ports; the real dev setup
# is left alone). Needs Playwright's Chromium once: bunx playwright@1.62.0 install chromium
screenshots: node_modules
	@trap 'docker compose -p talos-screenshots down -v >/dev/null 2>&1' EXIT; \
	docker compose -p talos-screenshots -f docker-compose.yml -f dev/screenshots/compose.override.yml up --build --detach --wait >/dev/null && \
	bun dev/screenshots/take-screenshots.ts

# Builds the container that goes on AWS.
server-image:
	docker build --platform $(SERVER_PLATFORM) -f talos-server/Dockerfile -t talos-server .

install:
	bun install

typecheck: node_modules
	bun run typecheck

test: node_modules
	bun run test

node_modules: package.json talos/package.json talos-server/package.json talos-shared/package.json talos-web/package.json talos-desktop/package.json
	bun install
	@touch node_modules

.env:
	@echo "No .env yet: copy .env.example to .env and fill it in." && exit 1
