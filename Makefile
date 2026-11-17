.PHONY: dev desktop talos server-image server-container install typecheck test

SERVER_PORT ?= 7070
# AWS Graviton (arm64) is cheaper than x86 and matches Apple silicon.
SERVER_PLATFORM ?= linux/arm64

# Runs talos-server and talos together. Ctrl-C stops both.
dev: node_modules .env
	@trap 'kill 0' INT TERM; \
	(cd talos-server && bun run dev) & \
	(cd talos && bun run dev) & \
	wait

# Opens the desktop app on the server's page. Run `make dev` first.
desktop: node_modules .env
	cd talos-desktop && bun run dev

# Runs only talos, for when the server runs somewhere else (like its container).
talos: node_modules .env
	cd talos && bun run dev

# Builds the container that goes on AWS.
server-image:
	docker build --platform $(SERVER_PLATFORM) -f talos-server/Dockerfile -t talos-server .

# Runs that container here, the way AWS would. Pair it with `make talos`.
server-container: server-image .env
	docker run --rm --name talos-server --env-file .env -e TALOS_SERVER_PORT=$(SERVER_PORT) -p $(SERVER_PORT):$(SERVER_PORT) talos-server

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
	@echo "No .env yet: copy .env.example to .env and set TALOS_MACHINE_KEY." && exit 1
