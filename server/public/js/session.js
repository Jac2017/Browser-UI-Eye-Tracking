const sessionId = location.pathname.split('/').pop();
(async () => {
  try {
    const res = await api('/sessions/' + sessionId + '/summary');
    const data = await res.json();
    renderSummary(data.summary, document.getElementById('content'));
  } catch (err) {
    document.getElementById('content').innerHTML = '<div class="status-msg error">' + esc(err.message) + '</div>';
  }
})();
