import React, { useState } from 'react';
import { Dataset } from '../types';
import { Lightbulb, FlaskConical, Play, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../utils/api';
import Orb from './Orb';
import { useLogRun } from '../contexts/WorkspaceContext';

interface HypothesisLabProps {
  dataset: Dataset;
}

interface Hypothesis {
  statement: string;
  suggestedTest: string;
  columnsInvolved: string[];
}

export default function HypothesisLab({ dataset }: HypothesisLabProps) {
  const logRun = useLogRun();
  const [loading, setLoading] = useState(false);
  const [hypotheses, setHypotheses] = useState<Hypothesis[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // States for testing
  const [testingHypothesisIdx, setTestingHypothesisIdx] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, any>>({});
  const [interpretations, setInterpretations] = useState<Record<number, string>>({});
  const [customHypothesisText, setCustomHypothesisText] = useState('');
  const [customColA, setCustomColA] = useState(dataset.columns[0]?.name || '');
  const [customColB, setCustomColB] = useState(dataset.columns[1]?.name || dataset.columns[0]?.name || '');

  const handleRunCustomTest = () => {
    if (!customHypothesisText.trim() || !customColA || !customColB) return;
    const newHypothesis: Hypothesis = {
      statement: customHypothesisText,
      suggestedTest: 'Custom (columns picked below)',
      columnsInvolved: [customColA, customColB]
    };
    
    const nextIdx = hypotheses ? hypotheses.length : 0;
    const updatedList = hypotheses ? [...hypotheses, newHypothesis] : [newHypothesis];
    
    setHypotheses(updatedList);
    setCustomHypothesisText('');
    
    runTest(nextIdx, newHypothesis);
  };

  const generateHypotheses = async () => {
    setLoading(true);
    setError(null);
    try {
      const dataSample = dataset.rows.slice(0, 10); // Provide short sample
      const response = await apiFetch('/api/hypothesis-lab/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns: dataset.columns, dataSample })
      });
      const data = await response.json();
      if (response.ok && data.hypotheses) {
        setHypotheses(data.hypotheses);
      } else {
        setError(data.error || 'Failed to generate hypotheses.');
      }
    } catch (err: any) {
      setError('Network error running Hypothesis Generator.');
    } finally {
      setLoading(false);
    }
  };

  const runTest = async (idx: number, hypothesis: Hypothesis) => {
     setTestingHypothesisIdx(idx);

     // Real test: pick the first 2 columns from the hypothesis that actually
     // exist in this dataset (an AI-generated hypothesis could name more than
     // 2, or hallucinate one that doesn't exist) and send the real rows to
     // the ML service, which chooses and runs a genuine scipy.stats test
     // (correlation / t-test / ANOVA / chi-squared) based on real column
     // dtypes - never a random or guessed number.
     const testColumns = hypothesis.columnsInvolved.filter(c => dataset.columns.some(col => col.name === c)).slice(0, 2);

     if (testColumns.length < 2) {
       setTestResults(prev => ({ ...prev, [idx]: {
         error: true,
         message: 'Could not identify two real columns in your dataset to test this hypothesis against.'
       } }));
       setTestingHypothesisIdx(null);
       return;
     }

     let result: any;
     try {
       const resp = await apiFetch('/api/hypothesis-lab/run-test', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ data: dataset.rows, columns: testColumns })
       });
       const data = await resp.json();
       if (!resp.ok) {
         throw new Error(data.error || `Server responded with ${resp.status}`);
       }
       result = data;
       setTestResults(prev => ({ ...prev, [idx]: result }));
       logRun({
         kind: 'hypothesis-test',
         title: `${result.testName ?? 'Statistical test'}: ${testColumns.join(' vs ')}`,
         summary: typeof result.pValue === 'number'
           ? `p = ${result.pValue < 0.0001 ? '< 0.0001' : result.pValue.toFixed(4)} · ${result.rejectNull ? 'significant' : 'not significant'}`
           : 'Completed',
         status: 'succeeded',
         params: { hypothesis: hypothesis.statement, columns: testColumns },
         result,
       });
     } catch (err: any) {
       console.error('Hypothesis test failed', err);
       logRun({
         kind: 'hypothesis-test',
         title: `Test: ${testColumns.join(' vs ')}`,
         summary: 'Failed',
         status: 'failed',
         params: { hypothesis: hypothesis.statement, columns: testColumns },
         error: err.message || String(err),
       });
       setTestResults(prev => ({ ...prev, [idx]: {
         error: true,
         message: err.message || 'Real statistical test failed - is the ML compute service running?'
       } }));
       setTestingHypothesisIdx(null);
       return;
     }

     // Feed the real result back to interpret (narration only - the numbers
     // above already came from the real test, this just explains them).
     try {
       const resp = await apiFetch('/api/hypothesis-lab/interpret', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ hypothesis, result })
       });
       const data = await resp.json();
       if (resp.ok && data.interpretation) {
         setInterpretations(prev => ({ ...prev, [idx]: data.interpretation }));
       } else {
         throw new Error(data.error || `Server responded with ${resp.status}`);
       }
     } catch (err: any) {
       console.error("Interpretation failed", err);
       setInterpretations(prev => ({ ...prev, [idx]: 'AI interpretation unavailable (network or server error). The test statistic above is still valid.' }));
     } finally {
       setTestingHypothesisIdx(null);
     }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="bg-surface border border-separator rounded-xl p-6 sm:p-8">
        <div className="text-center mb-8">
          <FlaskConical className="w-12 h-12 text-blue mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-label mb-2">Hypothesis testing</h3>
          <p className="text-sm text-label-2 max-w-xl mx-auto">
            Test your own specific business questions, or ask the AI to uncover hidden hypotheses 
            and automatically test them against your dataset.
          </p>
        </div>

        <div className="flex flex-col md:flex-row gap-6 max-w-4xl mx-auto">
          {/* AI Generator Side */}
          <div className="flex-1 bg-well p-6 rounded-xl border border-separator flex flex-col items-center justify-center text-center">
            <h4 className="font-semibold text-label text-sm mb-2">Let AI find patterns</h4>
            <p className="text-xs text-label-2 mb-6">Automatically generate and test intelligent hypotheses based on your data distribution.</p>
            <button
              onClick={generateHypotheses}
              disabled={loading}
              className="bg-blue hover:bg-blue disabled:bg-fill disabled:text-label-2 text-white font-semibold py-3 px-6 rounded-xl transition-all inline-flex items-center justify-center gap-2 w-full text-sm"
            >
              {loading ? <Orb state="searching" label="Looking for patterns" /> : <Lightbulb className="w-4 h-4" />}
              {loading ? 'Looking for patterns…' : 'Generate Deep Hypotheses'}
            </button>
          </div>

          {/* Divider on desktop */}
          <div className="hidden md:flex items-center justify-center">
            <div className="w-[1px] h-full bg-fill"></div>
          </div>

          {/* Custom Side */}
          <div className="flex-[1.5] bg-well p-6 rounded-xl border border-separator flex flex-col justify-center">
            <h4 className="font-semibold text-label text-sm mb-2">Test your own hypothesis</h4>
            <p className="text-xs text-label-2 mb-4">Have a specific question in mind? Write it down, pick the two real columns it's about, and we'll run a genuine statistical test between them.</p>
            <input
              type="text"
              value={customHypothesisText}
              onChange={(e) => setCustomHypothesisText(e.target.value)}
              placeholder="e.g. Higher tenure implies lower churn..."
              className="w-full bg-surface border border-separator-strong rounded-xl px-4 py-3 text-sm text-label placeholder-label-3 focus:outline-none focus:border-blue focus:ring-1 focus:ring-blue transition-all mb-3"
              onKeyDown={(e) => { if (e.key === 'Enter') handleRunCustomTest(); }}
            />
            <div className="flex flex-col sm:flex-row gap-3">
               <select
                 value={customColA}
                 onChange={(e) => setCustomColA(e.target.value)}
                 className="flex-1 bg-surface border border-separator-strong rounded-xl px-3 py-2.5 text-xs text-label focus:outline-none focus:border-blue"
               >
                 {dataset.columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
               </select>
               <select
                 value={customColB}
                 onChange={(e) => setCustomColB(e.target.value)}
                 className="flex-1 bg-surface border border-separator-strong rounded-xl px-3 py-2.5 text-xs text-label focus:outline-none focus:border-blue"
               >
                 {dataset.columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
               </select>
               <button
                 onClick={handleRunCustomTest}
                 disabled={!customHypothesisText.trim() || !customColA || !customColB || testingHypothesisIdx !== null}
                 className="bg-fill hover:bg-fill-strong disabled:bg-fill disabled:text-label-3 text-label font-semibold py-2.5 px-6 rounded-xl transition-all text-sm flex items-center justify-center gap-2 shrink-0"
               >
                 <Play className="w-4 h-4" /> Test It
               </button>
            </div>
          </div>
        </div>

        {error && <p className="text-red text-sm mt-6 text-center">{error}</p>}
      </div>

      {hypotheses && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {hypotheses.map((h, idx) => (
            <div key={idx} className="bg-surface border border-separator rounded-xl p-5 shadow-sm">
               <h4 className="font-semibold text-label text-sm mb-2">{h.statement}</h4>
               <div className="flex items-center gap-2 mb-4 text-xs tabular-nums">
                  <span className="bg-fill text-blue px-2 py-1 rounded">Test: {h.suggestedTest}</span>
                  <span className="bg-fill text-label-2 px-2 py-1 rounded">Cols: {h.columnsInvolved.join(', ')}</span>
               </div>
               
               {!testResults[idx] ? (
                 <button 
                   onClick={() => runTest(idx, h)}
                   disabled={testingHypothesisIdx === idx}
                   className="w-full flex justify-center items-center gap-2 py-2 bg-blue/10 hover:bg-blue/20 text-blue rounded-lg text-xs font-semibold transition-all"
                 >
                   {testingHypothesisIdx === idx ? <Orb state="solving" label="Running the test" /> : <Play className="w-3.5 h-3.5" />}
                   {testingHypothesisIdx === idx ? 'Running Test...' : 'Run This Test'}
                 </button>
               ) : testResults[idx].error ? (
                 <div className="bg-red/10 border border-red/20 p-3 rounded-lg flex items-start gap-2">
                   <AlertTriangle className="w-4 h-4 text-red shrink-0 mt-0.5" />
                   <p className="text-xs text-red">{testResults[idx].message}</p>
                 </div>
               ) : (
                 <div className="bg-well p-4 rounded-lg border border-separator">
                    <div className="text-[11px] text-label-3 tabular-nums mb-2">Real test run: {testResults[idx].testName}</div>
                    <div className="flex items-center justify-between mb-3 border-b border-separator pb-2">
                       <span className="text-xs text-label-2 tabular-nums">p-value: <strong className={testResults[idx].rejectNull ? 'text-green' : 'text-red'}>{testResults[idx].pValue.toFixed(4)}</strong></span>
                       <span className="text-xs text-label-2 tabular-nums">Statistic: <strong>{testResults[idx].testStatistic}</strong></span>
                       <span className="text-xs text-label-2 tabular-nums">n = <strong>{testResults[idx].sampleSize}</strong></span>
                    </div>
                    {interpretations[idx] ? (
                       <p className="text-sm text-label leading-relaxed">{interpretations[idx]}</p>
                    ) : (
                       <div className="flex items-center gap-2 text-label-2 text-xs">
                         <Orb state="composing" label="Writing an interpretation" /> Writing an interpretation…
                       </div>
                    )}
                 </div>
               )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
