# Frontend

This is the Next.js frontend for MNIST Mosaic Studio.

It talks to the FastAPI backend in `../backend`.

Run it locally with:

```bash
cp .env.example .env.local
bun install
bun run dev
```

For Vercel, set the project Root Directory to `frontend` and add
`NEXT_PUBLIC_API_URL=https://your-backend.onrender.com`.

This frontend pins Node `20.x` for Vercel in `package.json`, and
`frontend/.node-version` mirrors that locally.
