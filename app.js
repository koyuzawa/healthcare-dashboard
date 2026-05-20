/* ヘルスケアダッシュボード
 * iPhone「ヘルスケア」アプリの export.zip / export.xml をブラウザだけで解析・可視化する。
 * 大きなファイルでも動くように、Blob をチャンク読みしながら正規表現で <Record> を取り出し、
 * パース中に日次集計まで済ませる（生レコードはメモリに溜めない）。
 */

(() => {
  "use strict";

  // ===== メトリクス定義 =========================================================
  // aggregation:
  //   sum    : 日次合計（歩数、距離、消費カロリーなど）
  //   avg    : 日次平均（心拍など）
  //   last   : 日次の最終値（体重など、スパースな値）
  //   sleep  : SleepAnalysis のカテゴリ値から「睡眠」時間を計算
  const METRICS = {
    StepCount: {
      key: "StepCount",
      label: "歩数",
      type: "HKQuantityTypeIdentifierStepCount",
      aggregation: "sum",
      unit: "歩",
      color: "#4f46e5",
      format: (v) => Math.round(v).toLocaleString(),
    },
    DistanceWalkingRunning: {
      key: "DistanceWalkingRunning",
      label: "歩行・走行距離",
      type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
      aggregation: "sum",
      unit: "km",
      color: "#06b6d4",
      format: (v) => v.toFixed(2),
    },
    ActiveEnergyBurned: {
      key: "ActiveEnergyBurned",
      label: "アクティブエネルギー",
      type: "HKQuantityTypeIdentifierActiveEnergyBurned",
      aggregation: "sum",
      unit: "kcal",
      color: "#f59e0b",
      format: (v) => Math.round(v).toLocaleString(),
    },
    FlightsClimbed: {
      key: "FlightsClimbed",
      label: "上った階数",
      type: "HKQuantityTypeIdentifierFlightsClimbed",
      aggregation: "sum",
      unit: "階",
      color: "#14b8a6",
      format: (v) => Math.round(v).toLocaleString(),
    },
    HeartRate: {
      key: "HeartRate",
      label: "心拍数（平均）",
      type: "HKQuantityTypeIdentifierHeartRate",
      aggregation: "avg",
      unit: "bpm",
      color: "#ef4444",
      format: (v) => Math.round(v).toLocaleString(),
    },
    RestingHeartRate: {
      key: "RestingHeartRate",
      label: "安静時心拍数",
      type: "HKQuantityTypeIdentifierRestingHeartRate",
      aggregation: "avg",
      unit: "bpm",
      color: "#ec4899",
      format: (v) => Math.round(v).toLocaleString(),
    },
    BodyMass: {
      key: "BodyMass",
      label: "体重",
      type: "HKQuantityTypeIdentifierBodyMass",
      aggregation: "last",
      unit: "kg",
      color: "#8b5cf6",
      format: (v) => v.toFixed(1),
    },
    SleepAnalysis: {
      key: "SleepAnalysis",
      label: "睡眠時間",
      type: "HKCategoryTypeIdentifierSleepAnalysis",
      aggregation: "sleep",
      unit: "時間",
      color: "#6366f1",
      format: (v) => v.toFixed(1),
    },
  };

  const TYPE_TO_METRIC = Object.fromEntries(
    Object.values(METRICS).map((m) => [m.type, m])
  );

  // ===== DOM =====================================================================
  const $ = (id) => document.getElementById(id);
  const ui = {
    uploadView: $("upload-view"),
    loadingView: $("loading-view"),
    dashboardView: $("dashboard-view"),
    errorView: $("error-view"),
    fileInput: $("file-input"),
    dropZone: $("drop-zone"),
    loadingText: $("loading-text"),
    progressFill: $("progress-fill"),
    progressDetail: $("progress-detail"),
    statsGrid: $("stats-grid"),
    chartsGrid: $("charts-grid"),
    dateRangeLabel: $("date-range-label"),
    resetBtn: $("reset-btn"),
    errorText: $("error-text"),
    errorBack: $("error-back"),
  };

  // ===== 状態 ===================================================================
  // aggregates[metricKey] = { 'YYYY-MM-DD': { sum, count, last } }
  let aggregates = createEmptyAggregates();
  let units = {}; // 実データから取得した実際のユニット
  let selectedRange = 30; // 'all' or number
  const charts = {}; // Chart.js インスタンスをキャッシュして再利用

  function createEmptyAggregates() {
    const o = {};
    for (const k of Object.keys(METRICS)) o[k] = Object.create(null);
    return o;
  }

  // ===== ビュー切り替え ==========================================================
  function showView(name) {
    for (const v of ["uploadView", "loadingView", "dashboardView", "errorView"]) {
      ui[v].hidden = true;
    }
    ui[name].hidden = false;
    ui.resetBtn.hidden = name !== "dashboardView";
  }

  function setProgress(text, pct, detail) {
    ui.loadingText.textContent = text;
    if (typeof pct === "number") {
      ui.progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    }
    ui.progressDetail.textContent = detail || "";
  }

  function showError(msg) {
    ui.errorText.textContent = msg;
    showView("errorView");
  }

  // ===== ファイル入力 ============================================================
  ui.fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
  });

  ui.dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    ui.dropZone.classList.add("drag-over");
  });
  ui.dropZone.addEventListener("dragleave", () => {
    ui.dropZone.classList.remove("drag-over");
  });
  ui.dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    ui.dropZone.classList.remove("drag-over");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  ui.resetBtn.addEventListener("click", () => {
    aggregates = createEmptyAggregates();
    units = {};
    ui.fileInput.value = "";
    showView("uploadView");
  });

  ui.errorBack.addEventListener("click", () => showView("uploadView"));

  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = btn.dataset.range;
      selectedRange = r === "all" ? "all" : Number(r);
      document
        .querySelectorAll(".range-btn")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      renderDashboard();
    });
  });

  // ===== ファイル処理 ============================================================
  async function handleFile(file) {
    aggregates = createEmptyAggregates();
    units = {};
    showView("loadingView");
    setProgress("読み込み中...", 0, file.name);

    try {
      if (/\.zip$/i.test(file.name) || file.type === "application/zip") {
        setProgress("ZIPを開いています...", 5, file.name);
        const zip = await JSZip.loadAsync(file);
        const xmlEntry =
          zip.file(/(^|\/)export\.xml$/i)[0] || zip.file("export.xml");
        if (!xmlEntry) {
          throw new Error(
            "ZIP内に export.xml が見つかりませんでした。Apple Healthの書き出しファイルか確認してください。"
          );
        }
        setProgress("解析中...", 10, "0%");
        // iOSのメモリ制約を考慮し、解凍済みXML全体をメモリに置かず
        // JSZipから流れてくる文字列チャンクを直接パースする。
        await parseFromJSZipStream(xmlEntry, (pct) => {
          setProgress("解析中...", 10 + pct * 0.85, `${Math.round(pct)}%`);
        });
      } else if (/\.xml$/i.test(file.name) || file.type === "text/xml") {
        setProgress("解析中...", 10, "0%");
        await parseFromBlob(file, (pct) => {
          setProgress("解析中...", 10 + pct * 0.85, `${Math.round(pct)}%`);
        });
      } else {
        throw new Error(".zip または .xml ファイルを選択してください。");
      }

      setProgress("ダッシュボードを描画中...", 98, "");
      renderDashboard();
      showView("dashboardView");
    } catch (err) {
      console.error(err);
      showError(err.message || String(err));
    }
  }

  // ===== XML パース + 集計 =======================================================
  // チャンクで来た文字列を、タグ境界で安全に切りながら <Record> 抽出する小ヘルパ。
  // パース中に日次バケットへ集計するので、生レコードはメモリに残さない。
  function makeChunkProcessor() {
    let leftover = "";
    const recordRe = /<Record\s+([^>]+?)\/?>/g;
    return {
      process(text, isFinal) {
        let combined = leftover + text;
        let processed, remaining;
        if (isFinal) {
          processed = combined;
          remaining = "";
        } else {
          const cutoff = combined.lastIndexOf(">");
          if (cutoff === -1) {
            leftover = combined;
            return;
          }
          processed = combined.substring(0, cutoff + 1);
          remaining = combined.substring(cutoff + 1);
        }
        let m;
        recordRe.lastIndex = 0;
        while ((m = recordRe.exec(processed)) !== null) {
          ingestRecord(m[1]);
        }
        leftover = remaining;
      },
    };
  }

  // 生XMLファイル向け: Blobをチャンク読みして処理
  async function parseFromBlob(blob, onProgress) {
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
    const total = blob.size;
    const cp = makeChunkProcessor();
    let offset = 0;
    while (offset < total) {
      const end = Math.min(offset + CHUNK_SIZE, total);
      const chunkText = await blob.slice(offset, end).text();
      cp.process(chunkText, end >= total);
      offset = end;
      onProgress((offset / total) * 100);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // ZIP向け: JSZipのinternalStreamで解凍チャンクを直接受け取りつつ処理。
  // 解凍済みXML全体をメモリに展開しないので、iOS Safariなど低メモリ環境向け。
  function parseFromJSZipStream(xmlEntry, onProgress) {
    return new Promise((resolve, reject) => {
      const cp = makeChunkProcessor();
      xmlEntry
        .internalStream("string")
        .on("data", (data, metadata) => {
          cp.process(data, false);
          if (metadata && typeof metadata.percent === "number") {
            onProgress(metadata.percent);
          }
        })
        .on("error", (e) => reject(e))
        .on("end", () => {
          cp.process("", true);
          onProgress(100);
          resolve();
        })
        .resume();
    });
  }

  function ingestRecord(attrsStr) {
    // 属性を素早く取り出す（必要なものだけ）
    const type = attrValue(attrsStr, "type");
    if (!type) return;
    const metric = TYPE_TO_METRIC[type];
    if (!metric) return;

    if (metric.aggregation === "sleep") {
      const value = attrValue(attrsStr, "value");
      // 「In Bed」は除外し、Asleep系のみ睡眠時間としてカウント
      if (!value || !/Asleep/.test(value)) return;
      const startDate = attrValue(attrsStr, "startDate");
      const endDate = attrValue(attrsStr, "endDate");
      if (!startDate || !endDate) return;
      const ms = Date.parse(endDate) - Date.parse(startDate);
      if (!isFinite(ms) || ms <= 0) return;
      // 起床日（endDate）に紐付け
      const date = endDate.substring(0, 10);
      addToBucket(metric.key, date, ms / 3600000); // hours
      return;
    }

    const valStr = attrValue(attrsStr, "value");
    const v = parseFloat(valStr);
    if (!isFinite(v)) return;
    const startDate = attrValue(attrsStr, "startDate");
    if (!startDate) return;
    const date = startDate.substring(0, 10);

    if (!units[metric.key]) {
      const u = attrValue(attrsStr, "unit");
      if (u) units[metric.key] = u;
    }
    addToBucket(metric.key, date, v);
  }

  function addToBucket(key, date, value) {
    const bucket = aggregates[key];
    let b = bucket[date];
    if (!b) {
      b = { sum: 0, count: 0, last: 0 };
      bucket[date] = b;
    }
    b.sum += value;
    b.count += 1;
    b.last = value;
  }

  // 軽量な属性抜き出し（DOMParserより速い）
  function attrValue(s, name) {
    const needle = name + '="';
    let i = s.indexOf(needle);
    if (i === -1) return null;
    // 属性名の前が空白/開始であることを確認（"sourceName" などへの誤マッチ回避）
    if (i > 0) {
      const c = s.charCodeAt(i - 1);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) {
        // 名前が部分一致しているだけ→次を探す
        return attrValueFromIndex(s, name, i + 1);
      }
    }
    i += needle.length;
    const j = s.indexOf('"', i);
    if (j === -1) return null;
    return s.substring(i, j);
  }
  function attrValueFromIndex(s, name, fromIdx) {
    const needle = name + '="';
    let i = s.indexOf(needle, fromIdx);
    while (i !== -1) {
      if (i === 0 || /\s/.test(s[i - 1])) {
        const start = i + needle.length;
        const end = s.indexOf('"', start);
        return end === -1 ? null : s.substring(start, end);
      }
      i = s.indexOf(needle, i + 1);
    }
    return null;
  }

  // ===== ダッシュボード描画 ======================================================
  function renderDashboard() {
    // 全データの最終日を求める（あれば）
    let globalLast = null;
    for (const m of Object.values(METRICS)) {
      const dates = Object.keys(aggregates[m.key]);
      for (const d of dates) {
        if (!globalLast || d > globalLast) globalLast = d;
      }
    }
    if (!globalLast) {
      ui.statsGrid.innerHTML =
        '<div class="muted">読み込んだファイルから集計可能なデータが見つかりませんでした。</div>';
      ui.chartsGrid.innerHTML = "";
      ui.dateRangeLabel.textContent = "";
      return;
    }

    // 期間決定
    const endDate = globalLast;
    let startDate;
    if (selectedRange === "all") {
      // 全体での最初の日付を見つける
      let first = null;
      for (const m of Object.values(METRICS)) {
        for (const d of Object.keys(aggregates[m.key])) {
          if (!first || d < first) first = d;
        }
      }
      startDate = first;
    } else {
      const d = new Date(endDate + "T00:00:00");
      d.setDate(d.getDate() - (selectedRange - 1));
      startDate = isoDate(d);
    }

    ui.dateRangeLabel.textContent = `${formatJP(startDate)} 〜 ${formatJP(endDate)}`;

    renderStats(startDate, endDate);
    renderCharts(startDate, endDate);
  }

  function renderStats(startDate, endDate) {
    ui.statsGrid.innerHTML = "";
    for (const m of Object.values(METRICS)) {
      const series = seriesForRange(m, startDate, endDate);
      if (series.length === 0) continue;
      const summary = summarize(m, series);
      const card = document.createElement("div");
      card.className = "stat-card";
      card.innerHTML = `
        <div class="stat-label">
          <span>${m.label}</span>
          <span class="stat-swatch" style="background:${m.color}"></span>
        </div>
        <div class="stat-value">${summary.primaryFormatted}<span class="stat-unit">${summary.primaryUnit}</span></div>
        <div class="stat-sub">${summary.sub}</div>
      `;
      ui.statsGrid.appendChild(card);
    }
  }

  function renderCharts(startDate, endDate) {
    // 既存のチャートをdestroyしてから再描画
    for (const id of Object.keys(charts)) {
      charts[id].destroy();
      delete charts[id];
    }
    ui.chartsGrid.innerHTML = "";

    for (const m of Object.values(METRICS)) {
      const series = seriesForRange(m, startDate, endDate);
      const card = document.createElement("div");
      card.className = "chart-card";
      card.innerHTML = `
        <div class="chart-card-header">
          <div class="chart-card-title">
            <span class="stat-swatch" style="background:${m.color}"></span>
            ${m.label}
          </div>
          <div class="chart-card-meta">${unitLabel(m)}</div>
        </div>
        <div class="chart-wrap"></div>
      `;
      ui.chartsGrid.appendChild(card);
      const wrap = card.querySelector(".chart-wrap");

      if (series.length === 0) {
        const empty = document.createElement("div");
        empty.className = "chart-empty";
        empty.textContent = "この期間のデータはありません";
        wrap.appendChild(empty);
        continue;
      }

      const canvas = document.createElement("canvas");
      wrap.appendChild(canvas);

      const labels = series.map((p) => p.date);
      const values = series.map((p) => p.value);
      const isBar = m.aggregation === "sum" || m.aggregation === "sleep";

      charts[m.key] = new Chart(canvas, {
        type: isBar ? "bar" : "line",
        data: {
          labels,
          datasets: [
            {
              label: m.label,
              data: values,
              backgroundColor: isBar ? m.color : hexAlpha(m.color, 0.15),
              borderColor: m.color,
              borderWidth: isBar ? 0 : 2,
              borderRadius: 3,
              pointRadius: 0,
              pointHoverRadius: 4,
              tension: 0.25,
              fill: !isBar,
              spanGaps: m.aggregation === "last",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => formatJP(items[0].label),
                label: (item) => {
                  const v = item.parsed.y;
                  return `${m.format(v)} ${unitLabel(m)}`;
                },
              },
            },
          },
          scales: {
            x: {
              ticks: {
                maxRotation: 0,
                autoSkip: true,
                maxTicksLimit: 8,
                callback: function (val) {
                  const label = this.getLabelForValue(val);
                  return formatShort(label);
                },
              },
              grid: { display: false },
            },
            y: {
              beginAtZero: m.aggregation !== "last",
              grid: { color: "#eef0f6" },
              ticks: {
                callback: (v) => {
                  if (v >= 10000) return (v / 1000).toFixed(0) + "k";
                  return v;
                },
              },
            },
          },
        },
      });
    }
  }

  // ===== ユーティリティ ==========================================================
  function seriesForRange(metric, startDate, endDate) {
    const bucket = aggregates[metric.key];
    const out = [];
    // 期間内の日付を 1日ずつ走査して、データ点を作る
    const start = new Date(startDate + "T00:00:00");
    const end = new Date(endDate + "T00:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const iso = isoDate(d);
      const b = bucket[iso];
      if (!b) {
        // last の場合のみキャリーフォワードしない（線が伸び続けるのを避ける）。
        // sum/avg の0日は欠損として扱う。
        if (metric.aggregation === "last") {
          out.push({ date: iso, value: null });
        } else {
          out.push({ date: iso, value: 0 });
        }
        continue;
      }
      let v;
      if (metric.aggregation === "sum" || metric.aggregation === "sleep") v = b.sum;
      else if (metric.aggregation === "avg") v = b.sum / b.count;
      else if (metric.aggregation === "last") v = b.last;
      out.push({ date: iso, value: v });
    }
    // 全て欠損なら空配列を返す
    const hasAny = out.some((p) => p.value !== null && p.value !== 0);
    return hasAny ? out : [];
  }

  function summarize(metric, series) {
    const vals = series
      .map((p) => p.value)
      .filter((v) => v !== null && !Number.isNaN(v));
    if (vals.length === 0) {
      return { primaryFormatted: "—", primaryUnit: "", sub: "" };
    }
    let primary, sub, label;
    if (metric.aggregation === "sum" || metric.aggregation === "sleep") {
      const sum = vals.reduce((a, b) => a + b, 0);
      const nonZero = vals.filter((v) => v > 0);
      const avg = nonZero.length ? sum / nonZero.length : 0;
      primary = avg;
      label = `平均/日`;
      sub = `合計 ${metric.format(sum)} ${unitLabel(metric)}`;
    } else if (metric.aggregation === "avg") {
      const sum = vals.reduce((a, b) => a + b, 0);
      primary = sum / vals.length;
      label = `平均`;
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      sub = `${metric.format(min)}〜${metric.format(max)} ${unitLabel(metric)}`;
    } else {
      // last
      const last = vals[vals.length - 1];
      primary = last;
      label = `最新`;
      const first = vals[0];
      const diff = last - first;
      const sign = diff > 0 ? "+" : "";
      sub =
        vals.length > 1
          ? `期間内 ${sign}${metric.format(diff)} ${unitLabel(metric)}`
          : "";
    }
    return {
      primaryFormatted: metric.format(primary),
      primaryUnit: unitLabel(metric),
      sub: `${label}・${sub}`,
    };
  }

  function unitLabel(metric) {
    // SleepAnalysis は固定で「時間」、距離は km と仮定（mi のときは元単位を表示）
    if (metric.aggregation === "sleep") return "時間";
    const u = units[metric.key];
    if (!u) return metric.unit;
    // Apple Healthのデフォルト単位はmetric.unitと一致することが多い。
    // unitが`count`や`count/min`などのときは独自ラベルを優先
    if (metric.key === "StepCount") return "歩";
    if (metric.key === "FlightsClimbed") return "階";
    if (metric.key === "HeartRate" || metric.key === "RestingHeartRate") return "bpm";
    return u;
  }

  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function formatJP(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${y}年${Number(m)}月${Number(d)}日`;
  }
  function formatShort(iso) {
    if (!iso) return "";
    const parts = iso.split("-");
    if (parts.length < 3) return iso;
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }
  function hexAlpha(hex, alpha) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
})();
