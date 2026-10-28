@echo off
chcp 65001 > nul
cd /d %~dp0
if not exist config.bat (
  copy config.example.bat config.bat > nul
  echo [처음 실행] config.bat 을 메모장으로 엽니다. 센서 ID, Apps Script 주소, 토큰을 채우고 저장한 뒤 다시 실행하세요.
  notepad config.bat
  exit /b
)
call config.bat
echo.
echo  AI 예보관 브리지 시험 메뉴  (센서 %SENSOR_ID%)
echo  1. 주변 센서와 측정 항목 보기        (--list)
echo  2. 센서 읽기만 시험(시트 전송 없음)   (--dry-run)
echo  3. 시트 연결만 시험(센서 없이 가짜 3행)
echo  4. 실시간 전송 시작                  (수업용)
echo.
set /p CH=번호를 고르세요: 
if "%CH%"=="1" python pasco_bridge.py --list
if "%CH%"=="2" python pasco_bridge.py --weather %SENSOR_ID% --dry-run
if "%CH%"=="3" python test_post.py --gas "%GAS_URL%" --token %TOKEN%
if "%CH%"=="4" python pasco_bridge.py --weather %SENSOR_ID% --gas "%GAS_URL%" --token %TOKEN%
pause
