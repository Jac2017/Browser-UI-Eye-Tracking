const studyId = location.pathname.split('/').pop();
(async () => {
  try {
    const res = await api('/studies/' + studyId);
    const studyData = await res.json();
    const aggRes = await api('/studies/' + studyId + '/aggregate');
    const aggData = await aggRes.json();
    const study = studyData.study;
    const participants = studyData.participants;
    const aggregate = aggData.aggregate;
    document.getElementById('content').innerHTML =
      '<h2>' + esc(study.name) + '</h2>' +
      '<p style="color:var(--text-muted);margin-bottom:24px">' + esc(study.description) + '</p>' +
      '<div class="card-grid">' +
        '<div class="card"><div class="label">Sessions</div><div class="value">' + fmtNum(aggregate.sessions) + '</div></div>' +
        '<div class="card"><div class="label">Total Events</div><div class="value">' + fmtNum(aggregate.totalEvents) + '</div></div>' +
        '<div class="card"><div class="label">Gaze Points</div><div class="value">' + fmtNum(aggregate.gazePoints) + '</div></div>' +
        '<div class="card"><div class="label">Fixations</div><div class="value">' + fmtNum(aggregate.fixations) + '</div></div>' +
        '<div class="card"><div class="label">Engagement</div><div class="value">' + fmtNum(aggregate.engagement ? aggregate.engagement.score : 0) + '</div></div>' +
        '<div class="card"><div class="label">Participants</div><div class="value">' + fmtNum(participants.length) + '</div></div>' +
      '</div>' +
      '<h3 style="margin:24px 0 12px">Groups</h3>' +
      '<div class="card-grid">' +
        Object.entries(aggregate.groups || {}).map(function(entry) {
          return '<div class="card"><div class="label">' + esc(entry[0]) + '</div><div class="value">' + fmtNum(entry[1].participants) + ' / ' + fmtNum(entry[1].sessions) + ' sessions</div></div>';
        }).join('') +
      '</div>';
  } catch (err) {
    document.getElementById('content').innerHTML = '<div class="status-msg error">' + esc(err.message) + '</div>';
  }
})();
