FROM node:24-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

# The unprivileged variant: nginx runs as uid 101 with its pid and temp
# files in /tmp, so the pod can be Pod Security 'restricted'. It still
# listens on 80; the pod allows that through a sysctl.
FROM nginxinc/nginx-unprivileged:1.30-alpine
USER root
# Pick up Alpine fixes that landed after the nginx image was built
# (Trivy, 2026-11-15: libxslt).
RUN apk upgrade --no-cache

# Copy static files
COPY --from=build /app/dist /usr/share/nginx/html

# Custom nginx config with /api proxy
COPY nginx.conf /etc/nginx/conf.d/default.conf
USER 101

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
