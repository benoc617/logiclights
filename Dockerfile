# Logic Lights — static SPA served by nginx under /lights/
# Built for linux/arm64 (ECS Fargate Graviton), works anywhere.
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/lights/
