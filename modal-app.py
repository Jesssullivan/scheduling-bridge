"""
Modal Labs deployment for the scheduling middleware server.

Runs the Node.js middleware server with Playwright + Chromium
inside a Modal container with GPU-free compute.

Usage:
    modal deploy modal-app.py              # Deploy to Modal
    modal serve modal-app.py               # Local dev with hot reload
    modal run modal-app.py                 # One-shot test run

Environment variables (set in Modal dashboard or .env):
    AUTH_TOKEN           - Required Bearer token for all endpoints
    ACUITY_BASE_URL      - Acuity scheduling URL
    ACUITY_BYPASS_COUPON - 100% gift certificate code
    PLAYWRIGHT_HEADLESS  - Browser headless mode (default: true)
    PLAYWRIGHT_TIMEOUT   - Page timeout in ms (default: 30000)
"""

import modal

app = modal.App("scheduling-middleware")

# Base image: Playwright's official image with Chromium pre-installed
image = (
    modal.Image.from_registry(
        "mcr.microsoft.com/playwright:v1.58.2-noble",
        add_python="3.12",
    )
    .run_commands(
        # Remove Node 24 from Playwright image, install Node 22 LTS
        "apt-get remove -y nodejs || true",
        "rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx",
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        "node --version",
        "corepack enable && corepack prepare pnpm@9.15.9 --activate",
        "apt-get clean && rm -rf /var/lib/apt/lists/*",
    )
    .add_local_file("package.json", "/app/package.json", copy=True)
    .add_local_dir("src", "/app/src", copy=True)
    .add_local_file("tsconfig.json", "/app/tsconfig.json", copy=True)
    .run_commands(
        # Install all deps then compile TS → JS with esbuild (bundler handles fp-ts resolution)
        "cd /app && pnpm install --no-frozen-lockfile",
        "cd /app && pnpm add esbuild",
        # Bundle middleware server to a single JS file with all deps inlined
        # External: playwright (runtime dep), tinyland-auth-pg (not used by middleware)
        "cd /app && npx esbuild src/middleware/server.ts"
        " --bundle --platform=node --format=esm --outfile=dist/server.mjs"
        " --external:playwright-core --external:playwright"
        " --external:@playwright/test"
        " --external:@tummycrypt/*"
        " --external:@neondatabase/*"
        " --external:drizzle-orm --external:drizzle-orm/*"
        " --external:@skeletonlabs/* --external:svelte --external:svelte/*",
        "ls -la /app/dist/server.mjs",
    )
)


@app.function(
    image=image,
    # No GPU needed - browser automation only
    cpu=2.0,
    memory=2048,
    # Keep warm for low latency (1 container always ready)
    min_containers=1,
    # 5 minute timeout (wizard can take up to 60s per booking)
    timeout=300,
    secrets=[modal.Secret.from_name("scheduling-middleware-secrets")],
)
@modal.concurrent(max_inputs=1)
@modal.web_server(port=3001, startup_timeout=30)
def server():
    import subprocess

    subprocess.Popen(
        ["node", "dist/server.mjs"],
        cwd="/app",
        env={
            **__import__("os").environ,
            "NODE_ENV": "production",
            "PORT": "3001",
            "PLAYWRIGHT_HEADLESS": "true",
        },
    )
