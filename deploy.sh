#!/bin/bash
cd "$(dirname "$0")"
git pull
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --build
