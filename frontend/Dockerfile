FROM node:24-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

FROM nginx:1.30-alpine
# Pick up Alpine fixes that landed after the nginx image was built
# (Trivy, 2026-11-15: libxslt).
RUN apk upgrade --no-cache

# Copy static files
COPY --from=build /app/dist /usr/share/nginx/html

# Custom nginx config with /api proxy
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
