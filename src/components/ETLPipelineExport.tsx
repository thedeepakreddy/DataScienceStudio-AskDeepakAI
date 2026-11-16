import React, { useState } from 'react';
import { Download, Terminal, Workflow, AlertCircle } from 'lucide-react';
import { usePipelineContext } from '../contexts/PipelineContext';
import { describeCleaningOperation } from '../utils/cleaningOperations';
import { CleaningOperation } from '../types';
import { apiFetch } from '../utils/api';
import Orb from './Orb';

export default function ETLPipelineExport() {
  const { cleaningSteps } = usePipelineContext();
  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const realTransformations = (cleaningSteps as CleaningOperation[]).map(describeCleaningOperation);

  const generateScript = async () => {
     setLoading(true);
     setError(null);

     try {
       const response = await apiFetch('/api/etl-script-generator', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           transformations: realTransformations.length > 0
             ? realTransformations
             : ['No cleaning operations were applied in Cleaning Studio for this dataset.']
         })
       });
       
       const data = await response.json();
       if (data.script) {
          setScript(data.script);
       } else {
          setError(data.error || 'Failed to generate ETL script.');
       }
     } catch (err) {
       setError('Network error pulling script.');
     } finally {
       setLoading(false);
     }
  };

  const downloadScript = () => {
    if (!script) return;
    const blob = new Blob([script], { type: 'text/x-python;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `etl_pipeline_${Date.now()}.py`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="bg-surface border border-separator rounded-2xl p-6 sm:p-8 mt-8 shadow-sm relative overflow-hidden animate-fade-in">
       <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 bg-green/10 rounded-lg flex items-center justify-center border border-green/20">
               <Workflow className="w-5 h-5 text-green" />
             </div>
             <div>
               <h2 className="text-xl font-semibold text-label tracking-tight">Export pipeline as Python</h2>
               <p className="text-xs text-label-2 mt-1">Generate a runnable Python script of your data transformations.</p>
             </div>
          </div>
          {!script && !loading && (
             <button
                onClick={generateScript}
                className="bg-green hover:bg-green text-white font-semibold text-sm py-2 px-6 rounded-xl transition-all shadow-sm"
             >
                Generate Script
             </button>
          )}
       </div>

       {!script && !loading && (
         <div className="mb-6 text-xs text-label-2 bg-well border border-separator rounded-xl p-4">
           {realTransformations.length > 0 ? (
             <>
               <p className="font-semibold text-label mb-2">Real operations that will be encoded into this script ({realTransformations.length}):</p>
               <ul className="space-y-1 list-disc list-inside">
                 {realTransformations.map((t, i) => <li key={i}>{t}</li>)}
               </ul>
             </>
           ) : (
             <p>No cleaning operations have been applied yet in Cleaning Studio — the exported script will reflect that honestly rather than invent steps you didn't take.</p>
           )}
         </div>
       )}

       {loading && (
          <div className="py-8 flex flex-col items-center justify-center">
             <Orb state="weaving" size={64} label="Assembling the pipeline script" className="mb-4" />
             <p className="text-sm font-semibold text-label">Writing pandas and SQLAlchemy code...</p>
          </div>
       )}

       {error && (
         <div className="p-4 bg-red/10 border border-red/20 text-red rounded-xl text-xs flex items-start gap-3 mb-6">
           <AlertCircle className="w-4 h-4 text-red shrink-0 mt-0.5" />
           <p>{error}</p>
         </div>
       )}

       {script && (
          <div className="space-y-4">
             <div className="bg-well p-4 rounded-xl border border-separator overflow-x-auto">
               <div className="flex items-center gap-2 mb-3 text-label-3 text-xs tabular-nums">
                 <Terminal className="w-4 h-4" /> pipeline.py
               </div>
               <pre className="text-xs text-green tabular-nums leading-relaxed">{script}</pre>
             </div>
             
             <div className="flex justify-end">
                <button
                   onClick={downloadScript}
                   className="flex items-center gap-2 bg-fill hover:bg-fill-strong text-green font-semibold text-sm py-2 px-6 rounded-xl transition-all border border-separator-strong"
                >
                   <Download className="w-4 h-4" /> Download ETL Script (.py)
                </button>
             </div>
          </div>
       )}
    </div>
  );
}
