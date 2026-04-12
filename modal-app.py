"""
Modal Labs deployment for the scheduling bridge server.

Runs the Node.js bridge server with Playwright + Chromium
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
    .add_local_file("pnpm-lock.yaml", "/app/pnpm-lock.yaml", copy=True)
    .add_local_dir("src", "/app/src", copy=True)
    .add_local_file("tsconfig.json", "/app/tsconfig.json", copy=True)
    .run_commands(
        # Build the same dist/server/handler.js artifact used by pnpm start.
        "cd /app && pnpm install --frozen-lockfile",
        "cd /app && pnpm build",
        "ls -la /app/dist/server/handler.js",
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
@modal.concurrent(max_inputs=3)
@modal.web_server(port=3001, startup_timeout=30)
def server():
    import subprocess

    subprocess.Popen(
        ["node", "dist/server/handler.js"],
        cwd="/app",
        env={
            **__import__("os").environ,
            "NODE_ENV": "production",
            "PORT": "3001",
            "PLAYWRIGHT_HEADLESS": "true",
        },
    )
