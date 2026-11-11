# 카카오톡 인라인 GIF

대화창에 표시된 GIF를 말풍선 위치에서 재생합니다. 해당 대화창에 포커스가 있을 때 움직이고, 다른 창으로 옮기면 현재 프레임에서 멈춥니다. 돌아오면 이어서 재생합니다.

- 설치 위치: `%LOCALAPPDATA%\KakaoTalkInlineGif`
- 실행: `KakaoTalkInlineGif.exe`. Windows 로그인 후에도 자동으로 시작합니다.
- 일시 중지: 알림 영역의 재생 아이콘을 오른쪽 클릭하고 **인라인 GIF 사용**을 끕니다.
- 이번 실행 종료: 같은 메뉴에서 **종료**를 누릅니다.
- 자동 시작까지 끄기: `Disable-KakaoTalkInlineGif.cmd`를 실행합니다. 카카오톡과 캐시는 유지됩니다.
- 다시 켜기: `KakaoTalkInlineGif.exe`를 실행합니다. 자동 시작 등록은 설치 스크립트를 다시 실행하면 복구됩니다.

카카오톡 26.9.2.5342를 기준으로 검증한 보조 프로그램입니다. 카카오톡 업데이트 후 실행 파일이 달라지면 적용을 멈춥니다. 원본 카카오톡 실행 파일은 수정하지 않습니다.

표시할 원본 GIF는 이 PC의 `cache` 폴더에 보관합니다. 실행 상태와 진단 로그는 `runtime` 폴더에 저장합니다. 문의할 때 GIF 캐시나 대화 식별자가 들어 있는 원본 로그를 그대로 공유하지 마세요.

## 설치 스크립트

`Install-KakaoTalkInlineGif.ps1`은 같은 작업 폴더의 `package`, 별도로 준비한 Node.js, Frida 의존성을 검증한 뒤 사용자 전용 경로에 복사합니다. 관리자 권한은 필요하지 않습니다. 기존 설치가 있으면 먼저 정상 종료를 요청하고 기존 캐시와 사용 설정을 보존합니다. 이전 설치는 같은 상위 폴더의 `KakaoTalkInlineGif.backup-*`로 남습니다.

`-CheckOnly`는 경로와 필수 파일만 확인하며 설치하거나 실행하지 않습니다. `-NoStart`는 설치 후 실행을 생략하고, `-NoStartup`은 이번 설치에서 자동 시작 등록을 생략합니다.

자동 시작을 등록하기 전에 기존 사용자 시작 프로그램 레지스트리 키를 `runtime\startup-before-install-*.reg`로 내보냅니다. 백업에 실패하면 등록하지 않습니다. 기존 키는 다시 만들지 않으며, `KakaoTalkInlineGif` 값만 추가하거나 갱신합니다. `StartupRegistration.ps1`을 설치 스크립트와 같은 폴더에 두어야 합니다. `Test-StartupRegistration.ps1`은 실제 시작 프로그램 키 대신 별도 임시 키에서 이 동작을 검증합니다.

`Get-KakaoTalkInlineGifValidation.ps1`은 실행 상태·오류 개수·코드 해시를 조회하여 검증용 JSON을 만듭니다. 대화 제목·대화 식별자·미디어 키·GIF 내용·로그 본문은 포함하지 않습니다. `-AppRoot`로 검사할 설치 폴더를, `-ReportPath`로 저장할 JSON 경로를 지정할 수 있습니다.
