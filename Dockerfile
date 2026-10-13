# Lionsgate Bank SME credit desk: no dependencies beyond Node itself.
FROM node:20-alpine
WORKDIR /app
COPY --chown=node:node . .
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "server.js"]
