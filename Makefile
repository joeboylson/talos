.PHONY: dev down logs desktop talos server-image install typecheck test

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

# Runs only talos, for when the server is already up.
talos: node_modules .env
	cd talos && bun run dev

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
