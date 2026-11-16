import React, { useState, useEffect } from 'react';
import { MLResult } from '../types';
import { Brain, Sparkles, AlertCircle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiFetch } from '../utils/api';
import Orb from './Orb';

interface ModelExplainerProps {
  result: any;
}

export default function ModelExplainer({ result }: ModelExplainerProps) {
  const [loading, setLoading] = useState(false);
  const [explanation, setExplanation] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    generateExplanation();
  }, [result]);

  const generateExplanation = async () => {
    setLoading(true);
    setError(null);
    try {
       const rawFiData = result.featureImportance || result.algorithmDetails?.featureImportance || {};
       const isArray = Array.isArray(rawFiData);
       let formattedFiParams: Record<string, number> = {};
       if (isArray) {
           rawFiData.forEach((item: any) => {
               formattedFiParams[item.feature] = item.score;
           });
       } else {
           formattedFiParams = rawFiData;
       }

       const metrics = result.metrics || {};
       const context = {
          target: result.targetSelected || "Target Variable",
          features: result.featuresSelected || Object.keys(formattedFiParams),
          type: result.modelType || "Unknown ML Predictor"
       };
       
       const response = await apiFetch('/api/model-explainer', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ featureImportance: formattedFiParams, metrics, context })
       });

       const data = await response.json();
       if (response.ok && data.overallSummary) {
          setExplanation(data);
       } else {
          setError(data.error || 'Failed to explain model.');
       }
    } catch(err) {
       setError('Network error generating explanation.');
    } finally {
       setLoading(false);
    }
  };

  const rawFiData = result.featureImportance || result.algorithmDetails?.featureImportance || {};
  const isArray = Array.isArray(rawFiData);
  const fiData = isArray 
    ? [...rawFiData]
       .sort((a, b) => b.score - a.score)
       .slice(0, 5)
       .map(val => ({ name: val.feature, importance: Number((val.score * 100).toFixed(1)) }))
    : Object.entries(rawFiData)
       .sort((a, b) => (b[1] as number) - (a[1] as number))
       .slice(0, 5)
       .map(([name, val]) => ({ name, importance: Number(((val as number)*100).toFixed(1)) }));

  return (
     <div className="bg-surface rounded-2xl border border-separator p-6 sm:p-8 shadow-sm relative overflow-hidden mt-8 animate-fade-in">
        
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-blue/10 rounded-lg flex items-center justify-center border border-blue/20">
            <Brain className="w-5 h-5 text-blue" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-label tracking-tight">Explain this model</h2>
            <p className="text-xs text-label-2 mt-1">Plain-English translation of feature importance and model dynamics.</p>
          </div>
        </div>

        {error && (
           <div className="p-4 bg-red/10 border border-red/20 text-red rounded-xl text-xs flex items-start gap-3 mb-6">
             <AlertCircle className="w-4 h-4 text-red shrink-0 mt-0.5" />
             <p>{error}</p>
           </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
           {/* Chart */}
           <div>
              <h3 className="text-sm font-medium text-label mb-4 tabular-nums">Top drivers</h3>
              <div className="h-[250px] bg-well rounded-xl p-4 border border-separator">
                 <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={fiData} layout="vertical" margin={{ top: 0, right: 0, left: 30, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" horizontal={false} />
                      <XAxis type="number" stroke="var(--chart-axis)" fontSize={10} tickFormatter={(val) => `${val}%`} />
                      <YAxis dataKey="name" type="category" stroke="var(--chart-axis)" fontSize={10} width={80} />
                      <Tooltip 
                      />
                      <Bar dataKey="importance" fill="var(--chart-1)" radius={[0, 4, 4, 0]} barSize={16} />
                    </BarChart>
                 </ResponsiveContainer>
              </div>
           </div>

           {/* AI Story */}
           <div>
              {loading ? (
                <div className="h-full flex flex-col items-center justify-center bg-blue/10 border border-blue/20 rounded-xl p-6 text-center">
                   <Orb state="composing" size={64} label="Writing an explanation" className="mb-4" />
                   <h4 className="text-sm font-semibold text-label">How the model decides</h4>
                   <p className="text-xs text-label-2 mt-2">Gemini is analyzing decision trees and logistic weights to explain how this model thinks.</p>
                </div>
              ) : explanation ? (
                 <div className="space-y-4">
                    <div className="bg-well p-5 rounded-xl border border-separator">
                       <h4 className="text-xs font-medium text-blue mb-2 flex items-center gap-2">
                         <Sparkles className="w-3.5 h-3.5" /> Overall assessment
                       </h4>
                       <p className="text-sm text-label leading-relaxed">{explanation.overallSummary}</p>
                    </div>
                    
                    <div className="space-y-3">
                       {explanation.topFeatures?.slice(0, 2).map((feat: any, idx: number) => (
                         <div key={idx} className="bg-surface p-4 rounded-xl border border-separator">
                            <h5 className="text-sm font-semibold text-label">{feat.featureName}</h5>
                            <p className="text-xs text-label-2 mt-1 mb-2 italic">"{feat.explanation}"</p>
                            <p className="text-xs text-blue bg-blue/10 px-2 py-1.5 rounded-lg border border-blue/20">{feat.insight}</p>
                         </div>
                       ))}
                    </div>
                 </div>
              ) : null}
           </div>
        </div>
     </div>
  );
}
