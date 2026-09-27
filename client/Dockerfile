# ConvAI MVP — Client Dockerfile

FROM nginx:alpine

# Copy files
COPY . /usr/share/nginx/html/

# Fix permissions
RUN chmod +x /usr/share/nginx/html/entrypoint.sh

# Expose nginx port
EXPOSE 80

# Start script
CMD ["/bin/sh", "/usr/share/nginx/html/entrypoint.sh"]