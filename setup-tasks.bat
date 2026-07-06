@echo off
setlocal

set SKILL_DIR=C:\Users\irisding\.claude\skills\US-CCS-weekly-report
set NODE=node

echo === 注册 US CSS 周报自动化任务 ===

:: 任务1：每天中午12:00 刷新 session（保持 PASSPORT_SUPERSIG 存活）
schtasks /create /tn "USCSSRefreshSession" /tr "%NODE% \"%SKILL_DIR%\refresh-session.js\"" /sc DAILY /st 12:00 /f /rl HIGHEST
echo [OK] 每日 12:00 Session 刷新任务已注册

:: 任务2：每周五 20:00 自动生成并发送周报
schtasks /create /tn "USCSSWeeklyReport" /tr "%NODE% \"%SKILL_DIR%\auto-report.js\"" /sc WEEKLY /d FRI /st 20:00 /f /rl HIGHEST
echo [OK] 每周五 20:00 周报自动发送任务已注册

echo.
echo 任务已注册！可通过 Windows 任务计划程序查看和管理。
echo 注意：电脑需要在任务时间处于开机状态。
echo.
echo 初始配置：
echo 1. 编辑 %SKILL_DIR%\.env
echo 2. 填入 DATA_COOKIE（uIdToken，每2周更新一次）
echo 3. 确认 PASSPORT_SUPERSIG 已是最新值
echo.
pause
