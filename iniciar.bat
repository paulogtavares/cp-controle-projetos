@echo off
title C.P · Controle Projetos
echo.
echo   ============================================
echo    C.P · Controle Projetos
echo   ============================================
echo.

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo   ERRO: Node.js nao encontrado.
    echo   Baixe em: https://nodejs.org ^(versao LTS^)
    echo.
    pause
    exit /b 1
)

for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| find ":3131 "') do (
    taskkill /f /pid %%a >nul 2>&1
)

echo   Iniciando servidor em http://localhost:3131
echo   NAO feche esta janela enquanto estiver usando.
echo   Para parar pressione Ctrl+C
echo.

start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3131"
node server.js
pause

echo "# cp-controle-projetos" >> README.md 
git init 
git add README.md 
git commit -m "primeiro commit" 
git branch -M main 
git remote add origin https://github.com/pgtavares/cp-controle-projetos.git
 git push -u origin main