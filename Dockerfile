FROM nginx:1.31-alpine

# Identifica las imágenes de Snake (el deploy limpia solo las huérfanas con esta etiqueta).
LABEL org.opencontainers.image.title="snake-cicd"

# Configuración propia; se eliminan el sitio y las páginas por defecto de la
# imagen (index.html "Welcome to nginx" y 50x.html) para servir solo Snake.
RUN rm -f /etc/nginx/conf.d/default.conf \
 && rm -rf /usr/share/nginx/html/*
COPY nginx/nginx.conf /etc/nginx/nginx.conf

# Archivos estáticos de la aplicación (propiedad de root, solo lectura para nginx).
COPY src/ /usr/share/nginx/html/

EXPOSE 80

# Ejecutar sin privilegios de root.
USER nginx

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
