#!/bin/sh
# deploy.sh - Script de deploy para producao
# Uso: ./deploy.sh [start|stop|restart|logs|status|build]

set -e

COMPOSE_FILE="docker-compose.yml"
APP_NAME="painel-araguari"

# Carrega .env se existir
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

case "$1" in
  start)
    echo "Iniciando $APP_NAME..."
    docker compose -f $COMPOSE_FILE up -d --build
    echo "OK - rodando em http://localhost:${PORT:-3000}"
    ;;
  stop)
    echo "Parando $APP_NAME..."
    docker compose -f $COMPOSE_FILE down
    ;;
  restart)
    echo "Reiniciando $APP_NAME..."
    docker compose -f $COMPOSE_FILE down
    docker compose -f $COMPOSE_FILE up -d --build
    ;;
  logs)
    docker compose -f $COMPOSE_FILE logs -f --tail=100
    ;;
  status)
    docker compose -f $COMPOSE_FILE ps
    ;;
  build)
    echo "Rebuilding $APP_NAME..."
    docker compose -f $COMPOSE_FILE build --no-cache
    ;;
  backup)
    echo "Fazendo backup do banco..."
    TS=$(date +%Y%m%d_%H%M%S)
    docker run --rm -v painel_araguari_data:/data -v $(pwd)/backups:/backup \
      alpine tar czf /backup/vigilancia_$TS.tar.gz -C /data .
    echo "Backup salvo em backups/vigilancia_$TS.tar.gz"
    ;;
  *)
    echo "Uso: $0 {start|stop|restart|logs|status|build|backup}"
    exit 1
    ;;
esac
