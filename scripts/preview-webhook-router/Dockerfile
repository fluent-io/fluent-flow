FROM node:22-alpine

WORKDIR /app

COPY scripts/preview-webhook-router/router.mjs ./router.mjs

RUN mkdir -p /data && chown node:node /data

ENV PORT=3000
ENV ROUTER_STATE_DIR=/data

USER node
EXPOSE 3000

CMD ["node", "router.mjs"]
