# 악용 신고

sitey.my · sitey.one · officials.my · officials.one 아래의 이름이 피싱·악성코드·스팸 등 [약관](/terms)에 어긋나게 쓰이는 걸 보셨나요? 여기로 알려주세요. **계정은 필요 없습니다.**

신고는 모두 읽고, 약관을 어긴 이름은 내립니다.

<form id="abuse-form" class="abuse-form" method="post" action="/api/abuse-reports" data-sent="고맙습니다 — 신고가 접수됐습니다. 확인하겠습니다." data-failed="신고를 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요." data-limited="짧은 시간에 신고가 너무 많았습니다. 나중에 다시 시도해 주세요.">
<label for="abuse-target">주소</label>
<input id="abuse-target" name="target" type="text" required maxlength="512" placeholder="https://example.sitey.my" autocomplete="off">
<label for="abuse-reason">무엇이 문제인가요</label>
<textarea id="abuse-reason" name="reason" required maxlength="4000" rows="6" placeholder="무엇을 흉내 내는지, 무엇을 입력하라고 하는지, 링크를 어디서 봤는지…"></textarea>
<label for="abuse-contact">연락받을 곳 <span class="abuse-optional">(선택)</span></label>
<input id="abuse-contact" name="contact" type="text" maxlength="255" placeholder="이메일 등" autocomplete="email">
<button type="submit" class="primary-button">신고 보내기</button>
<p class="abuse-status" role="status" aria-live="polite"></p>
</form>

## sitey 자체의 보안 문제

나쁜 이름이 아니라 서비스의 취약점을 찾으셨다면 같은 양식으로 그렇다고 적어 보내주세요. [security.txt](/.well-known/security.txt) 도 이 페이지를 가리킵니다.
