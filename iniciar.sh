#!/bin/bash
echo ""
echo "  ============================================"
echo "   C.P · Controle Projetos"
echo "  ============================================"
echo ""

if ! command -v node &> /dev/null; then
    echo "  ERRO: Node.js não encontrado."
    echo "  Instale em: https://nodejs.org"
    exit 1
fi

echo "  Iniciando servidor em http://localhost:3131"
echo "  Para parar: Ctrl+C"
echo ""

# Open browser after 2s
(sleep 2 && open "http://localhost:3131" 2>/dev/null || xdg-open "http://localhost:3131" 2>/dev/null) &

node "$(dirname "$0")/server.js"
