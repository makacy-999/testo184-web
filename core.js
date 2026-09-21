/* Testo 184 报告 PDF 解析核心（浏览器/Node 通用，不依赖 DOM）
 *
 * 引擎A：PDF AcroForm 表单字段（pdfjs 注解）→ 标量字段 + 数据块（XML/长文本）
 * 引擎B：全文文本表格回退（时间+温度序列）
 *
 * 对外 API：
 *   parseReport({ fields, text }) -> 结构化报告
 *   extractFromPdf(pdf)           -> { fields, text }（pdfjs DocumentProxy）
 *   buildWorkbookAoa(data)        -> 三个 sheet 的 aoa（供 SheetJS）
 *   parseTime / parseNum          -> 工具
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.TestoCore = factory(); root.core = root.TestoCore; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------- 时间解析

  var DATE_PATTERNS = [
    { re: /\b(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})[ T](\d{1,2}:\d{2}(?::\d{2})?)/,
      yearFirst: true },
    { re: /\b(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})[ T](\d{1,2}:\d{2}(?::\d{2})?)/,
      yearFirst: false }
  ];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 解析日期三段字符串 -> {y, m, d}；无法确定返回 null。 */
  function splitDate(dateS, yearFirst) {
    var parts = dateS.split(/[-\/.]/).map(function (x) { return parseInt(x, 10); });
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    var y, a, b;
    if (yearFirst && parts[0] > 31) { y = parts[0]; a = parts[1]; b = parts[2]; }
    else if (!yearFirst && parts[2] > 31) { y = parts[2]; a = parts[0]; b = parts[1]; }
    else return null;
    // a/b 的月日顺序：先德式 (日,月)，越界则美式 (月,日)
    var candidates = [[a, b], [b, a]];
    for (var i = 0; i < candidates.length; i++) {
      var m = candidates[i][0], d = candidates[i][1];
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { y: y, m: m, d: d };
    }
    return null;
  }

  /** "2025-09-21 08:00" / "21.09.2025 08:00:30" ... -> 规范化字符串 或 null */
  function parseTime(s) {
    s = String(s == null ? '' : s).trim();
    for (var i = 0; i < DATE_PATTERNS.length; i++) {
      var m = DATE_PATTERNS[i].re.exec(s);
      if (!m) continue;
      var d = splitDate(m[1], DATE_PATTERNS[i].yearFirst);
      if (!d) continue;
      var t = m[2].split(':');
      var hh = parseInt(t[0], 10), mm = parseInt(t[1], 10);
      var ss = t.length > 2 ? parseInt(t[2], 10) : null;
      if (hh > 23 || mm > 59 || (ss !== null && ss > 59)) continue;
      var out = d.y + '-' + pad2(d.m) + '-' + pad2(d.d) + ' ' + pad2(hh) + ':' + pad2(mm);
      if (ss !== null) out += ':' + pad2(ss);
      return out;
    }
    return null;
  }

  // ------------------------------------------------------------- 数值解析

  var NUM_RE = /[-+]?\d+(?:[.,]\d+)?/;

  function parseNum(s) {
    if (s == null) return null;
    var m = NUM_RE.exec(String(s));
    if (!m) return null;
    var v = parseFloat(m[0].replace(',', '.'));
    return isNaN(v) ? null : Math.round(v * 100) / 100;
  }

  function validTemp(v) { return v !== null && v >= -90 && v <= 90; }

  // ------------------------------------------------------------ 数据块提取

  var ROW_SPLIT_RE = /\b(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4}[ T]\d{1,2}:\d{2}(?::\d{2})?)/g;

  function parseTextBlock(s) {
    var pts = [], m;
    ROW_SPLIT_RE.lastIndex = 0;
    while ((m = ROW_SPLIT_RE.exec(s)) !== null) {
      var t = parseTime(m[1]);
      if (!t) continue;
      var tail = s.slice(m.index + m[0].length, m.index + m[0].length + 30);
      var temp = parseNum(tail);
      if (temp !== null && validTemp(temp)) pts.push({ time: t, temp: temp });
    }
    return pts;
  }

  /** 从 XML 片段提取 (time, temp) 序列（正则方式，兼容 time/t/datetime 属性）。 */
  function parseXmlBlock(s) {
    var pts = [];
    var tagRe = /<[^>]*>/g, tag;
    while ((tag = tagRe.exec(s)) !== null) {
      var seg = tag[0];
      var tm = /(?:\btime|\bt\b|\bdatetime|\btimestamp|\bdate)\s*=\s*"([^"]+)"/i.exec(seg);
      if (!tm) continue;
      var t = parseTime(tm[1]);
      if (!t) continue;
      var vm = /(?:\btemp|\btemperature|\bvalue|\bv\b|\bval)\s*=\s*"([^"]+)"/i.exec(seg);
      var temp = vm ? parseNum(vm[1]) : null;
      if (temp !== null && validTemp(temp)) pts.push({ time: t, temp: temp });
    }
    return pts;
  }

  function looksLikeXml(s) { return /^\s*</.test(s); }

  function looksLikeData(name, value) {
    if (!value || value.length < 40) return false;
    var hits = 0, re = ROW_SPLIT_RE, m;
    re.lastIndex = 0;
    while ((m = re.exec(value)) !== null && hits < 3) hits++;
    if (hits >= 3) return true;
    return looksLikeXml(value) && /<value|<measurement|temp/i.test(value);
  }

  // -------------------------------------------------------- 引擎A：表单字段

  var SCALAR_HINTS = {
    sn: ['serial', 'seriennummer', 'sn_'],
    model: ['model', 'typ', 'device', 'logger type'],
    interval: ['interval', 'messintervall'],
    limit_min: ['min', 'lower', 'untergrenze'],
    limit_max: ['max', 'upper', 'obergrenze']
  };

  function matchScalar(name, value) {
    var low = String(name).toLowerCase();
    for (var key in SCALAR_HINTS) {
      var hints = SCALAR_HINTS[key];
      for (var i = 0; i < hints.length; i++) {
        if (low.indexOf(hints[i]) >= 0) {
          if (key === 'sn' || key === 'model') {
            var v = String(value).trim();
            if (v) return [key, v];
            return [null, null];
          }
          if (key === 'interval' || key === 'limit_min' || key === 'limit_max') {
            var n = parseNum(value);
            if (n !== null) return [key, n];
          }
          return [null, null];
        }
      }
    }
    return [null, null];
  }

  function parseByForm(fields) {
    if (!fields) return null;
    var meta = { engine: 'form' };
    var dataValues = [];
    for (var name in fields) {
      var value = fields[name];
      var hit = matchScalar(name, value);
      if (hit[0] && meta[hit[0]] === undefined) meta[hit[0]] = hit[1];
      if (looksLikeData(name, value)) dataValues.push([name, value]);
    }
    var points = [], used = null;
    for (var j = 0; j < dataValues.length; j++) {
      var val = dataValues[j][1];
      var pts;
      if (looksLikeXml(val)) {
        pts = parseXmlBlock(val);
        if (pts.length) { points = pts; used = 'xml'; break; }
      }
      pts = parseTextBlock(val);
      if (pts.length > points.length) { points = pts; used = 'form'; }
    }
    if (!points.length) return null;
    meta.engine = used || 'form';
    meta.points = points;
    return meta;
  }

  // ------------------------------------------------------------ 引擎B：文本

  var SN_TEXT_RE = /serial\s*(?:number|no\.?|nr\.?)?\s*[:：]?\s*([0-9]{4,})/i;
  var INTERVAL_TEXT_RE = /interval\s*[:：]?\s*(\d+)\s*(?:min|minute)/i;
  var LIMIT_TEXT_RE = /(?:limit|grenz|alarm)\s*(?:min|min\.?|lower)?\s*[:：]?\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:\.\.\.|to|-|–|\/|bis)\s*([+-]?\d+(?:[.,]\d+)?)/i;

  function parseByText(text) {
    if (!text) return null;
    var points = parseTextBlock(text);
    if (!points.length) return null;
    var meta = { engine: 'text', points: points };
    var m = SN_TEXT_RE.exec(text);
    if (m) meta.sn = m[1];
    m = INTERVAL_TEXT_RE.exec(text);
    if (m) meta.interval_min = parseNum(m[1]);
    m = LIMIT_TEXT_RE.exec(text);
    if (m) {
      var lo = parseNum(m[1]), hi = parseNum(m[2]);
      if (lo !== null && hi !== null) {
        meta.limit_min = Math.min(lo, hi);
        meta.limit_max = Math.max(lo, hi);
      }
    }
    return meta;
  }

  // ---------------------------------------------------------------- 主入口

  /** {fields, text} -> 标准报告结构；无数据抛 Error。 */
  function parseReport(input) {
    var result = parseByForm(input.fields) || parseByText(input.text);
    if (!result || !result.points || !result.points.length)
      throw new Error('未能从报告中提取到温度数据（需要按真实报告适配）');

    var seen = {}, order = [];
    for (var i = 0; i < result.points.length; i++) {
      var p = result.points[i];
      var t = parseTime(p.time);
      if (!t) continue;
      if (seen[t] === undefined) order.push(t);
      seen[t] = p.temp; // 同一时刻取后值
    }
    order.sort();
    var points = order.map(function (t) { return { time: t, temp: seen[t] }; });
    if (!points.length) throw new Error('报告中的时间戳均无法解析，需要按真实报告适配');

    result.points = points;
    result.start = points[0].time;
    result.end = points[points.length - 1].time;
    result.unit = '°C';
    result.sn = result.sn || '';
    result.model = result.model || '';
    result.interval_min = (result.interval_min === undefined) ? null : result.interval_min;
    result.limit_min = (result.limit_min === undefined) ? null : result.limit_min;
    result.limit_max = (result.limit_max === undefined) ? null : result.limit_max;
    result.warnings = [];
    if (!result.sn) result.warnings.push('报告中未识别到序列号，可手动填写测点名称');
    result.read_at = nowStr();
    return result;
  }

  function nowStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /** pdfjs DocumentProxy -> {fields, text}（引擎输入）。 */
  function extractFromPdf(pdf) {
    var fields = {};
    var textParts = [];
    var p = pdf.getPage ? null : null; // noop for clarity
    var jobs = [];
    for (var i = 1; i <= pdf.numPages; i++) jobs.push(pdf.getPage(i));
    return Promise.all(jobs).then(function (pages) {
      return Promise.all(pages.map(function (page) {
        return page.getAnnotations({ intent: 'display' }).then(function (anns) {
          (anns || []).forEach(function (a) {
            if (a.fieldName && a.fieldValue != null && a.fieldValue !== '')
              fields[a.fieldName] = String(a.fieldValue);
          });
          return page.getTextContent().then(function (tc) {
            textParts.push(tc.items.map(function (it) { return it.str; }).join(' '));
          });
        });
      }));
    }).then(function () {
      return { fields: fields, text: textParts.join('\n') };
    });
  }

  // ------------------------------------------------------------ Excel 构建

  function pointsOf(rec) {
    return (rec.points || []).filter(function (p) {
      return p && p.time && typeof p.temp === 'number';
    }).slice().sort(function (a, b) { return a.time < b.time ? -1 : 1; });
  }

  function displayName(rec) { return rec.user_name || rec.sn || ''; }

  function intervalText(rec, pts) {
    if (rec.interval_min) return rec.interval_min + ' 分钟';
    if (pts.length >= 3) {
      var t0 = pts[0][0].slice(0, 16), t1 = pts[1][0].slice(0, 16);
      var mins = (new Date(t1.replace(' ', 'T')) - new Date(t0.replace(' ', 'T'))) / 60000;
      if (mins > 0) return '约 ' + mins + ' 分钟（按数据推算）';
    }
    return '-';
  }

  /** data: {sn: rec} -> 3 个 sheet 的 {name, rows}（供 SheetJS aoa_to_sheet）。 */
  function buildWorkbookAoa(data) {
    var recs = [];
    for (var sn in data) {
      var pts = pointsOf(data[sn]);
      if (pts.length) recs.push({ sn: sn, rec: data[sn], pts: pts });
    }
    recs.sort(function (a, b) {
      return String(a.rec.first_seen || '').localeCompare(String(b.rec.first_seen || '')) ||
             a.sn.localeCompare(b.sn);
    });

    // 1) 测点汇总
    var s1 = [['序号', '测点名称', 'SN 序列号', '设备型号', '数据点数', '开始时间',
               '结束时间', '记录间隔', '最低温(°C)', '最高温(°C)', '平均温(°C)',
               '限值下限(°C)', '限值上限(°C)', '首次采集时间', '最后采集时间']];
    recs.forEach(function (r, i) {
      var temps = r.pts.map(function (p) { return p.temp; });
      var avg = temps.reduce(function (a, b) { return a + b; }, 0) / temps.length;
      s1.push([i + 1, displayName(r.rec), r.sn, r.rec.model || '-', r.pts.length,
               r.pts[0].time, r.pts[r.pts.length - 1].time,
               intervalText(r.rec, r.pts),
               Math.min.apply(null, temps), Math.max.apply(null, temps),
               Math.round(avg * 100) / 100,
               r.rec.limit_min, r.rec.limit_max,
               r.rec.first_seen || '-', r.rec.last_seen || '-']);
    });

    // 2) 温度汇总表（宽表，分钟对齐）
    var axis = {}, series = {};
    recs.forEach(function (r) {
      var col = {};
      r.pts.forEach(function (p) {
        var k = p.time.slice(0, 16);
        axis[k] = true;
        col[k] = p.temp;
      });
      series[r.sn] = col;
    });
    var times = Object.keys(axis).sort();
    var s2 = [['时间'].concat(recs.map(function (r) {
      return displayName(r.rec) + ' (' + r.sn + ')';
    }))];
    times.forEach(function (t) {
      var row = [t];
      recs.forEach(function (r) { row.push(series[r.sn][t] !== undefined ? series[r.sn][t] : null); });
      s2.push(row);
    });

    // 3) 明细数据
    var s3 = [['测点名称', 'SN 序列号', '时间', '温度(°C)']];
    recs.forEach(function (r) {
      r.pts.forEach(function (p) { s3.push([displayName(r.rec), r.sn, p.time, p.temp]); });
    });

    return [
      { name: '测点汇总', rows: s1 },
      { name: '温度汇总表', rows: s2 },
      { name: '明细数据', rows: s3 }
    ];
  }

  return {
    parseReport: parseReport,
    extractFromPdf: extractFromPdf,
    parseTime: parseTime,
    parseNum: parseNum,
    parseTextBlock: parseTextBlock,
    parseXmlBlock: parseXmlBlock,
    matchScalar: matchScalar,
    looksLikeData: looksLikeData,
    buildWorkbookAoa: buildWorkbookAoa,
    pointsOf: pointsOf
  };
});
