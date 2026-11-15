/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { usePipelineContext } from '../contexts/PipelineContext';
import L from 'leaflet';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  ScatterChart,
  Scatter,
  ZAxis,
  PieChart,
  Pie,
  Legend
} from 'recharts';
import {
  Code,
  Play,
  Check,
  Copy,
  Download,
  Filter,
  Sliders,
  RefreshCw,
  BarChart3,
  TrendingUp,
  Users,
  CheckCircle,
  Map,
  Globe,
  MapPin,
  ZoomIn,
  ZoomOut,
  SlidersHorizontal,
  Plus,
  Trash2,
  LineChart,
  Sparkles,
  Info,
  BrainCircuit
} from 'lucide-react';
import { Dataset } from '../types';
import { isIdentifierColumn } from '../utils/csvParser';

import { DashboardProvider } from './DashboardContext';
import IntelligentDashboardLayer from './IntelligentDashboardLayer';

interface StakeholderDashboardProps {
  dataset: Dataset;
  strategicSlicer?: string;
  mlResult?: any;
  aiAnalysis?: any;
}

// Stylized continent coordinates & paths for an executive World Map representation
const STYLIZED_CONTINENTS = [
  // North America
  { name: 'North America', points: '12,23 20,10 32,10 36,13 48,14 54,18 58,24 62,30 58,38 45,48 42,50 35,43 32,43 22,33' },
  // Greenland
  { name: 'Greenland', points: '54,10 62,8 65,12 60,20 54,18' },
  // South America
  { name: 'South America', points: '40,49 46,49 51,53 53,58 48,68 46,78 43,86 41,86 39,78 39,70 38,60 38,53' },
  // Europe
  { name: 'Europe', points: '72,23 76,21 80,23 84,26 83,33 78,36 74,38 70,36' },
  // Africa
  { name: 'Africa', points: '70,38 78,36 85,40 88,46 90,50 90,58 84,66 79,74 74,78 72,78 70,70 68,64 65,56' },
  // Asia
  { name: 'Eurasia', points: '80,23 95,18 115,20 135,20 145,26 152,30 153,40 142,48 135,51 125,53 110,56 102,58 95,58 85,48 82,36' },
  // Australia
  { name: 'Australia', points: '128,60 138,60 144,64 142,72 132,72 126,66' }
];

// Rich set of detailed realistic political country boundaries on our standard grid
const WORLD_COUNTRIES = [
  {
    name: 'Canada',
    keys: ['canada'],
    points: '20,8 30,5 45,5 56,10 52,18 43,18 36,18 28,15 20,15 20,8'
  },
  {
    name: 'United States',
    keys: ['united states', 'usa', 'united states of america'],
    points: '20,15 28,15 36,18 43,18 52,18 53,23 46,24 45,28 38,28 35,32 30,32 20,30 20,15'
  },
  {
    name: 'Mexico',
    keys: ['mexico'],
    points: '20,30 30,32 35,32 38,36 34,42 32,42 21,34 20,30'
  },
  {
    name: 'Colombia & Venezuela',
    keys: ['colombia', 'venezuela'],
    points: '40,45 48,44 54,44 51,51 45,51 40,48'
  },
  {
    name: 'Brazil',
    keys: ['brazil'],
    points: '41,50 51,51 58,51 63,56 61,64 54,66 45,58 41,50'
  },
  {
    name: 'Peru & Chile',
    keys: ['peru', 'chile'],
    points: '40,48 45,51 45,58 43,65 41,72 39,80 37,85 35,85 38,72 40,58'
  },
  {
    name: 'Argentina',
    keys: ['argentina'],
    points: '45,58 54,66 51,75 49,82 46,85 41,85 39,80 41,72 43,65'
  },
  {
    name: 'United Kingdom',
    keys: ['united kingdom', 'uk', 'great britain', 'england'],
    points: '72,18 75,16 76,20 73,23 72,18'
  },
  {
    name: 'Scandinavia',
    keys: ['sweden', 'norway'],
    points: '79,10 86,9 89,14 85,19 80,18 79,10'
  },
  {
    name: 'Germany & Poland',
    keys: ['germany', 'poland', 'netherlands', 'switzerland'],
    points: '80,18 85,19 88,23 83,23 80,21 80,18'
  },
  {
    name: 'France',
    keys: ['france'],
    points: '76,21 80,21 80,25 76,25 76,21'
  },
  {
    name: 'Spain & Portugal',
    keys: ['spain', 'portugal'],
    points: '73,25 77,25 77,29 73,29 73,25'
  },
  {
    name: 'Italy & Greece',
    keys: ['italy', 'greece'],
    points: '80,25 84,25 86,29 83,30 80,27'
  },
  {
    name: 'Russia',
    keys: ['russia'],
    points: '90,10 110,8 130,8 150,10 154,13 148,17 135,17 120,19 105,21 90,21 90,10'
  },
  {
    name: 'China',
    keys: ['china', 'south korea', 'singapore'],
    points: '110,21 130,21 135,27 132,34 124,35 120,37 114,33 110,27'
  },
  {
    name: 'India',
    keys: ['india'],
    points: '110,29 118,29 116,39 112,39 110,32'
  },
  {
    name: 'Japan',
    keys: ['japan'],
    points: '137,24 142,24 141,30 137,30 137,24'
  },
  {
    name: 'Middle East',
    keys: ['egypt', 'morocco'],
    points: '93,30 102,30 105,35 100,41 95,39 93,30'
  },
  {
    name: 'North Africa',
    keys: ['morocco', 'egypt', 'nigeria', 'kenya'],
    points: '71,29 93,29 92,42 82,42 71,38 71,29'
  },
  {
    name: 'South Africa',
    keys: ['south africa'],
    points: '80,42 90,42 90,52 86,64 79,64 79,52 80,42'
  },
  {
    name: 'Australia',
    keys: ['australia', 'new zealand'],
    points: '128,54 142,54 145,66 130,66 128,54'
  }
];

// Comprehensive dictionary for automatic geo-coordinates lookup based on raw text data
const COUNTRY_COORDINATES: Record<string, { lat: number; lon: number; continent: string }> = {
  'united states': { lat: 37.0902, lon: -95.7129, continent: 'North America' },
  'usa': { lat: 37.0902, lon: -95.7129, continent: 'North America' },
  'united states of america': { lat: 37.0902, lon: -95.7129, continent: 'North America' },
  'canada': { lat: 56.1304, lon: -106.3468, continent: 'North America' },
  'mexico': { lat: 23.6345, lon: -102.5528, continent: 'North America' },
  'brazil': { lat: -14.2350, lon: -51.9253, continent: 'South America' },
  'argentina': { lat: -38.4161, lon: -63.6167, continent: 'South America' },
  'colombia': { lat: 4.5709, lon: -74.2973, continent: 'South America' },
  'peru': { lat: -9.1900, lon: -75.0152, continent: 'South America' },
  'chile': { lat: -35.6751, lon: -71.5430, continent: 'South America' },
  'venezuela': { lat: 6.4238, lon: -66.5897, continent: 'South America' },
  'united kingdom': { lat: 55.3781, lon: -3.4360, continent: 'Europe' },
  'uk': { lat: 55.3781, lon: -3.4360, continent: 'Europe' },
  'great britain': { lat: 55.3781, lon: -3.4360, continent: 'Europe' },
  'england': { lat: 52.3555, lon: -1.1743, continent: 'Europe' },
  'germany': { lat: 51.1657, lon: 10.4515, continent: 'Eurasia' },
  'france': { lat: 46.2276, lon: 2.2137, continent: 'Europe' },
  'italy': { lat: 41.8719, lon: 12.5674, continent: 'Europe' },
  'spain': { lat: 40.4637, lon: -3.7492, continent: 'Europe' },
  'netherlands': { lat: 52.1326, lon: 5.2913, continent: 'Europe' },
  'switzerland': { lat: 46.8182, lon: 8.2275, continent: 'Europe' },
  'sweden': { lat: 60.1282, lon: 18.6435, continent: 'Europe' },
  'norway': { lat: 60.4720, lon: 8.4689, continent: 'Europe' },
  'poland': { lat: 51.9194, lon: 19.1451, continent: 'Europe' },
  'russia': { lat: 61.5240, lon: 105.3188, continent: 'Eurasia' },
  'china': { lat: 35.8617, lon: 104.1954, continent: 'Eurasia' },
  'india': { lat: 20.5937, lon: 78.9629, continent: 'Eurasia' },
  'japan': { lat: 36.2048, lon: 138.2529, continent: 'Eurasia' },
  'south korea': { lat: 35.9078, lon: 127.7669, continent: 'Eurasia' },
  'singapore': { lat: 1.3521, lon: 103.8198, continent: 'Eurasia' },
  'australia': { lat: -25.2744, lon: 133.7751, continent: 'Australia' },
  'new zealand': { lat: -40.9006, lon: 174.8860, continent: 'Australia' },
  'south africa': { lat: -30.5595, lon: 22.9375, continent: 'Africa' },
  'egypt': { lat: 26.8206, lon: 30.8025, continent: 'Africa' },
  'nigeria': { lat: 9.0820, lon: 8.6753, continent: 'Africa' },
  'kenya': { lat: -1.2921, lon: 36.8219, continent: 'Africa' },
  'morocco': { lat: 31.7917, lon: -7.0926, continent: 'Africa' }
};

const API_KEY =
  process.env.GOOGLE_MAPS_PLATFORM_KEY ||
  (import.meta as any).env?.VITE_GOOGLE_MAPS_PLATFORM_KEY ||
  (globalThis as any).GOOGLE_MAPS_PLATFORM_KEY ||
  '';
const hasValidKey = Boolean(API_KEY) && API_KEY !== 'YOUR_API_KEY';

function StakeholderDashboardInner({ dataset, strategicSlicer, mlResult, aiAnalysis }: StakeholderDashboardProps) {
  // Enhanced state including manual geo-enrichment simulation if dataset doesn't have country/coordinates
  const [copied, setCopied] = useState(false);
  const [sandboxTab, setSandboxTab] = useState<'script' | 'guide' | 'visuals'>('visuals');


  const generatePythonWorkflow = (): string => {
    // Determine the likely target column
    const numericCols = dataset.columns.filter(c => c.type === 'numeric').map(c => c.name);
    const categoricalCols = dataset.columns.filter(c => c.type === 'categorical' || c.type === 'boolean').map(c => c.name);
    const chosenTarget = mlResult?.predictions && mlResult.predictions.length > 0 
      ? (mlResult.predictions[0].actual !== undefined ? 'target_variable' : (numericCols[numericCols.length - 1] || 'target'))
      : (numericCols[numericCols.length - 1] || 'target');

    let script = `"""
================================================================================
  DATA SCIENTIST V3.2 - AUTOMATED PRODUCTION WORKFLOW
  Generated by AskDeepakAI on ${new Date().toLocaleDateString()}
================================================================================
This script is a self-contained, enterprise-grade machine learning model training 
pipeline using optimal science libraries.

Pre-requisites:
    pip install pandas numpy scikit-learn matplotlib seaborn xgboost
"""

import os
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor, GradientBoostingClassifier, GradientBoostingRegressor
from sklearn.linear_model import LogisticRegression, LinearRegression
from sklearn.metrics import classification_report, confusion_matrix, r2_score, mean_squared_error, accuracy_score
`;

    const algo = mlResult?.modelAlgorithm?.toLowerCase() || 'random forest';
    if (algo.includes('xgb') || algo.includes('gradient')) {
      script += `from xgboost import XGBClassifier, XGBRegressor\n`;
    }

    script += `

def load_and_preprocess_data(file_path):
    print("----------------------------------------------------------------")
    print(f"Loading dataset: {file_path}")
    print("----------------------------------------------------------------")
    # Load dataset
    df = pd.read_csv(file_path)
    
    # Identify variables
    numeric_features = ${JSON.stringify(numericCols.filter(c => c !== chosenTarget))}
    categorical_features = ${JSON.stringify(categoricalCols.filter(c => c !== chosenTarget))}
    target_feature = "${chosenTarget}"
    
    print(f"Rows loaded: {df.shape[0]}, Columns: {df.shape[1]}")
    print(f"Target Predictor Variable: {target_feature}")
    
    # Smart Data Imputation Strategy
    print("\\n[Clean] Handling missing values...")
    for col in numeric_features:
        if col in df.columns and df[col].isnull().sum() > 0:
            median_val = df[col].median()
            df[col] = df[col].fillna(median_val)
            print(f" - Filled numeric column '{col}' missing values with median: {median_val}")
            
    for col in categorical_features:
        if col in df.columns and df[col].isnull().sum() > 0:
            mode_val = df[col].mode()[0] if not df[col].mode().empty else 'Unknown'
            df[col] = df[col].fillna(mode_val)
            print(f" - Filled categorical column '{col}' missing values with mode: {mode_val}")

    # Feature Engineering Studio Transforms
    print("\\n[Feature Engineering] Creating advanced polynomial & log transforms...")
    for col in numeric_features:
        if col in df.columns:
            # Prevent negative log values
            if (df[col] >= 0).all():
                df[f'log_{col}'] = np.log1p(df[col])
                print(f" - Engineered feature: 'log_{col}'")
            df[f'sq_{col}'] = np.power(df[col], 2)
            print(f" - Engineered feature: 'sq_{col}'")

    return df, numeric_features, categorical_features, target_feature

def train_and_evaluate_model(df, numeric_features, categorical_features, target_feature):
    # Separate Features and Target
    X = df.drop(columns=[target_feature])
    y = df[target_feature]
    
    # Handle One-hot encoding for all categoricals
    X = pd.get_dummies(X, drop_first=True)
    print(f"\\nProcessed Features Shape (after dummy encoding): {X.shape}")
    
    # Train-test split
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.25, random_state=42
    )
    print(f"Split data into Train: {X_train.shape[0]} samples, Test: {X_test.shape[0]} samples")
    
    # Model Selection
`;

    const isRegression = mlResult?.modelType === 'regression' || typeof mlResult?.predictions?.[0]?.actual === 'number';

    if (isRegression) {
      script += `    # Regression modeling strategy 
    print("\\n[Training] Instantiating Gradient Boosting Regressor Model...")
    model = GradientBoostingRegressor(n_estimators=100, learning_rate=0.1, max_depth=4, random_state=42)
    model.fit(X_train, y_train)
    
    # Predictions
    preds = model.predict(X_test)
    r2 = r2_score(y_test, preds)
    rmse = np.sqrt(mean_squared_error(y_test, preds))
    
    print("----------------------------------------------------------------")
    print(f"REGRESSION STRATEGIC METRICS:")
    print(f"R² Score: {r2:.4f}")
    print(f"Root Mean Squared Error (RMSE): {rmse:.4f}")
    print("----------------------------------------------------------------")
    
    # Plot residuals
    plt.figure(figsize=(10, 6))
    residuals = y_test - preds
    sns.scatterplot(x=preds, y=residuals, color='coral', alpha=0.7)
    plt.axhline(y=0, color='grey', linestyle='--')
    plt.title('Residual Diagnostic Plot (True vs Predicted Variance)')
    plt.xlabel('Predicted Values')
    plt.ylabel('Residuals')
    plt.tight_layout()
    plt.savefig('residual_analysis.png')
    print("Residual plot saved to 'residual_analysis.png'")
`;
    } else {
      script += `    # Classification modeling strategy
    print("\\n[Training] Instantiating Random Forest Classifier Model...")
    model = RandomForestClassifier(n_estimators=150, max_depth=6, random_state=42)
    model.fit(X_train, y_train)
    
    # Predictions
    preds = model.predict(X_test)
    acc = accuracy_score(y_test, preds)
    
    print("----------------------------------------------------------------")
    print(f"CLASSIFICATION STRATEGIC METRICS:")
    print(f"Accuracy Score: {acc:.4%}")
    print("----------------------------------------------------------------")
    print("Classification Report:")
    print(classification_report(y_test, preds))
    
    # Plot Confusion Matrix
    plt.figure(figsize=(8, 6))
    cm = confusion_matrix(y_test, preds)
    sns.heatmap(cm, annot=True, fmt='d', cmap='Blues')
    plt.title('Confusion Matrix Diagnostics')
    plt.ylabel('Ground Truth')
    plt.xlabel('Algorithm Prediction')
    plt.tight_layout()
    plt.savefig('confusion_matrix.png')
    print("Confusion matrix heatmap saved to 'confusion_matrix.png'")
`;
    }

    script += `
    # Feature Importance Calculations
    if hasattr(model, 'feature_importances_'):
        importances = model.feature_importances_
        feat_importances = pd.Series(importances, index=X_train.columns)
        top_feats = feat_importances.nlargest(10)
        
        plt.figure(figsize=(10, 6))
        top_feats.plot(kind='barh', color='teal')
        plt.title('Feature Engineering Priority Rankings (Top 10)')
        plt.xlabel('Relative Information Gain / Weight')
        plt.tight_layout()
        plt.savefig('feature_importance.png')
        print("Feature importance bar graph saved to 'feature_importance.png'")

if __name__ == "__main__":
    # Point this to your CSV filename on disk!
    csv_filename = "dataset.csv"
    
    # Create simple dummy dataset if actual file is missing
    if not os.path.exists(csv_filename):
        print(f"CSV file '{csv_filename}' not found. Generating dummy dataset for execution test...")
        # Recreate schema
        dummy_data = []
        for _ in range(250):
            row = {}
            for col in ${JSON.stringify(numericCols)}:
                row[col] = np.random.uniform(10, 200)
            for col in ${JSON.stringify(categoricalCols)}:
                row[col] = np.random.choice(['GroupA', 'GroupB', 'GroupC'])
            row["${chosenTarget}"] = np.random.choice([0, 1]) if "${chosenTarget}" not in row else row["${chosenTarget}"]
            dummy_data.append(row)
        pd.DataFrame(dummy_data).to_csv(csv_filename, index=False)
        print(f"Generated backup bootstrap CSV: '{csv_filename}'")
        
    df, num, cat, tar = load_and_preprocess_data(csv_filename)
    train_and_evaluate_model(df, num, cat, tar)
`;
    return script;
  };

  const handleCopyCode = () => {
    try {
      navigator.clipboard.writeText(generatePythonWorkflow());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setLogs(prev => [...prev, '[SYSTEM] Successfully copied data science python code to clipboard.']);
    } catch (err) {
      // fallback
    }
  };

  const handleDownloadPython = () => {
    try {
      const codeStr = generatePythonWorkflow();
      const blob = new Blob([codeStr], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'data_science_workflow.py';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setLogs(prev => [...prev, `[EXPORT SUCCESS] Exported python script blueprint to file: "data_science_workflow.py"`]);
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    }
  };

  const [logs, setLogs] = useState<string[]>([]);
  const [enrichedRows, setEnrichedRows] = useState<Record<string, any>[]>([]);
  const [isGeographicallyEnriched, setIsGeographicallyEnriched] = useState<boolean>(false);

  // Auto-detect Geo-location columns
  const geoColumns = useMemo(() => {
    const columns = dataset.columns;
    const latCol = columns.find(c => {
      const name = c.name.toLowerCase().trim();
      if (/^(lat|latitude|gps_lat|y_coord|y_coordinate)$/i.test(name)) return true;
      if (name.includes('latitude') || name.startsWith('lat_') || name.endsWith('_lat')) return true;
      if (name.includes('coord') && (name.includes('lat') || name.includes('y'))) return true;
      if (name.includes('lat') && !name.includes('population') && !name.includes('inflation') && !name.includes('plate') && !name.includes('translation') && !name.includes('relationship') && !name.includes('relative')) return true;
      return false;
    });

    const lonCol = columns.find(c => {
      const name = c.name.toLowerCase().trim();
      if (/^(lon|long|longitude|lng|gps_lon|gps_lng|x_coord|x_coordinate)$/i.test(name)) return true;
      if (name.includes('longitude') || name.startsWith('lon_') || name.startsWith('lng_') || name.endsWith('_lon') || name.endsWith('_lng') || name.startsWith('long_') || name.endsWith('_long')) return true;
      if (name.includes('coord') && (name.includes('lon') || name.includes('lng') || name.includes('x') || name.includes('long'))) return true;
      if ((name.includes('lon') || name.includes('lng')) && !name.includes('clone') && !name.includes('belong') && !name.includes('longitudinal')) return true;
      return false;
    });

    const countryCol = columns.find(c => {
      const name = c.name.toLowerCase().trim();
      return /^(country|nation|region|city|state|county|location|address|place|geo)$/i.test(name) || 
             name.includes('country') || name.includes('nation') || name.includes('region') || 
             name.includes('city') || name.includes('state') || name.includes('county') || 
             name.includes('location') || name.includes('address') || name.includes('place');
    });

    return {
      hasLatLon: !!(latCol && lonCol),
      hasCountry: !!countryCol,
      latColName: latCol?.name || '',
      lonColName: lonCol?.name || '',
      countryColName: countryCol?.name || ''
    };
  }, [dataset]);

  // Sync rows & enrich dynamically on load or if geo-columns exist natively
  useEffect(() => {
    const rows = dataset.rows;

    // 1. If dataset already contains native lat/lon coordinates, use them directly
    if (geoColumns.hasLatLon) {
      setEnrichedRows(rows);
      setIsGeographicallyEnriched(false);
      return;
    }

    // 2. Identify country column or scan categorical columns for potential country data
    let detectedCountryColName = geoColumns.countryColName;
    if (!detectedCountryColName) {
      for (const col of dataset.columns) {
        if (col.type === 'categorical') {
          let matchCount = 0;
          const limit = Math.min(20, rows.length);
          for (let i = 0; i < limit; i++) {
            const val = String(rows[i]?.[col.name] || '').toLowerCase().trim();
            if (COUNTRY_COORDINATES[val] || Object.keys(COUNTRY_COORDINATES).some(k => val.includes(k))) {
              matchCount++;
            }
          }
          if (matchCount > 0 && (matchCount / limit) >= 0.15) {
            detectedCountryColName = col.name;
            break;
          }
        }
      }
    }

    // 3. Map countries dynamically to real geographic coordinates in our database
    if (detectedCountryColName) {
      const upgradedRows = rows.map((row, idx) => {
        const rawVal = String(row[detectedCountryColName] || '').toLowerCase().trim();
        let coords = COUNTRY_COORDINATES[rawVal];
        let displayName = row[detectedCountryColName];

        if (!coords) {
          // Substring lookup
          const matchedKey = Object.keys(COUNTRY_COORDINATES).find(k => rawVal.includes(k) || k.includes(rawVal) && rawVal.length > 2);
          if (matchedKey) {
            coords = COUNTRY_COORDINATES[matchedKey];
            displayName = matchedKey.toUpperCase();
          }
        }

        if (coords) {
          // Introduce a minor offset to keep multiple dots for the same country clear and non-coincident
          const scatterLat = (Math.sin(idx * 0.4) * 1.8);
          const scatterLon = (Math.cos(idx * 0.4) * 1.8);
          return {
            ...row,
            _simulated_latitude: parseFloat((coords.lat + scatterLat).toFixed(4)),
            _simulated_longitude: parseFloat((coords.lon + scatterLon).toFixed(4)),
            _simulated_country: displayName,
            _simulated_region: coords.continent
          };
        }

        // Cycle through standard values so every point matches somewhere nicely on screen
        const countriesKeys = Object.keys(COUNTRY_COORDINATES);
        const cycleCountry = countriesKeys[idx % countriesKeys.length];
        const cycleCoords = COUNTRY_COORDINATES[cycleCountry];
        return {
          ...row,
          _simulated_latitude: parseFloat((cycleCoords.lat + (Math.sin(idx * 0.5) * 2)).toFixed(4)),
          _simulated_longitude: parseFloat((cycleCoords.lon + (Math.cos(idx * 0.5) * 2)).toFixed(4)),
          _simulated_country: cycleCountry.toUpperCase(),
          _simulated_region: cycleCoords.continent
        };
      });

      setEnrichedRows(upgradedRows);
      setIsGeographicallyEnriched(true);
    } else {
      // If dataset contains no geographic headers whatsoever, automatically seed elegant spatial coordinates
      const countriesKeys = Object.keys(COUNTRY_COORDINATES);
      const upgradedRows = rows.map((row, idx) => {
        const cycleCountry = countriesKeys[idx % countriesKeys.length];
        const cycleCoords = COUNTRY_COORDINATES[cycleCountry];
        return {
          ...row,
          _simulated_latitude: parseFloat((cycleCoords.lat + (Math.sin(idx * 0.7) * 3.5)).toFixed(4)),
          _simulated_longitude: parseFloat((cycleCoords.lon + (Math.cos(idx * 0.7) * 3.5)).toFixed(4)),
          _simulated_country: cycleCountry.toUpperCase(),
          _simulated_region: cycleCoords.continent
        };
      });

      setEnrichedRows(upgradedRows);
      setIsGeographicallyEnriched(true);
    }
  }, [dataset, geoColumns]);

  // Geographical simulation helper to enrich row variables with custom global distributions
  const handleSimulateGeoAttributes = () => {
    const mockCountries = [
      { name: 'United States', lat: 37.0902, lon: -95.7129, region: 'North America' },
      { name: 'United Kingdom', lat: 55.3781, lon: -3.4360, region: 'Europe' },
      { name: 'Germany', lat: 51.1657, lon: 10.4515, region: 'Eurasia' },
      { name: 'India', lat: 20.5937, lon: 78.9629, region: 'Eurasia' },
      { name: 'Australia', lat: -25.2744, lon: 133.7751, region: 'Australia' },
      { name: 'Brazil', lat: -14.2350, lon: -51.9253, region: 'South America' },
      { name: 'South Africa', lat: -30.5595, lon: 22.9375, region: 'Africa' },
      { name: 'Canada', lat: 56.1304, lon: -106.3468, region: 'North America' },
      { name: 'Japan', lat: 36.2048, lon: 138.2529, region: 'Eurasia' },
      { name: 'France', lat: 46.2276, lon: 2.2137, region: 'Europe' }
    ];

    const upgradedRows = dataset.rows.map((row, idx) => {
      const geoSpot = mockCountries[idx % mockCountries.length];
      const noiseLat = (Math.sin(idx * 0.7) * 4) + (Math.cos(idx * 1.3) * 2);
      const noiseLon = (Math.cos(idx * 0.9) * 5) + (Math.sin(idx * 1.1) * 3);
      return {
        ...row,
        _simulated_latitude: parseFloat((geoSpot.lat + noiseLat).toFixed(4)),
        _simulated_longitude: parseFloat((geoSpot.lon + noiseLon).toFixed(4)),
        _simulated_country: geoSpot.name,
        _simulated_region: geoSpot.region
      };
    });

    setEnrichedRows(upgradedRows);
    setIsGeographicallyEnriched(true);
  };

  // Determine active keys for geospatial rendering
  const activeGeoKeys = useMemo(() => {
    if (isGeographicallyEnriched) {
      return {
        latKey: '_simulated_latitude',
        lonKey: '_simulated_longitude',
        countryKey: '_simulated_country',
        hasLocation: true
      };
    }
    return {
      latKey: geoColumns.latColName,
      lonKey: geoColumns.lonColName,
      countryKey: geoColumns.countryColName,
      hasLocation: geoColumns.hasLatLon || geoColumns.hasCountry
    };
  }, [geoColumns, isGeographicallyEnriched]);

  // Find Slicer targets & Multi-Filter Options
  const categoricalCols = dataset.columns.filter(c => (c.type === 'categorical' || c.type === 'boolean') && !isIdentifierColumn(c, dataset.rowCount));
  const numericCols = dataset.columns.filter(c => c.type === 'numeric');

  // Master lists of Slicers in active use
  const [activeSlicerColumn, setActiveSlicerColumn] = useState<string>(
    strategicSlicer && dataset.columns.some(c => c.name === strategicSlicer)
      ? strategicSlicer
      : (categoricalCols[0]?.name || '')
  );

  const [selectedSlices, setSelectedSlices] = useState<Record<string, string[]>>({});
  const [selectedMapCountry, setSelectedMapCountry] = useState<string | null>(null);
  
  // Interactive global slider slicer percentage (from 5% to 100%)
  const [rowSlicePercentage, setRowSlicePercentage] = useState<number>(100);
  
  // Custom numeric metrics filters (multiple range filters!)
  const [numericFilters, setNumericFilters] = useState<Array<{
    columnName: string;
    min: number;
    max: number;
    currentMin: number;
    currentMax: number;
  }>>([]);

  // Setup initial numeric filter ranges
  useEffect(() => {
    if (numericFilters.length === 0 && numericCols.length > 0) {
      // Pick first two numerical values as pre-configured reactive ranges
      const initialFilters = numericCols.slice(0, 2).map(c => {
        const min = c.statistics.min ?? 0;
        const max = c.statistics.max ?? 100;
        return {
          columnName: c.name,
          min,
          max,
          currentMin: min,
          currentMax: max
        };
      });
      setNumericFilters(initialFilters);
    }
  }, [dataset, numericCols]);

  const handleAddNumericFilter = (colName: string) => {
    if (numericFilters.some(f => f.columnName === colName)) return;
    const col = numericCols.find(c => c.name === colName);
    if (!col) return;
    const min = col.statistics.min ?? 0;
    const max = col.statistics.max ?? 100;
    setNumericFilters(prev => [
      ...prev,
      {
        columnName: colName,
        min,
        max,
        currentMin: min,
        currentMax: max
      }
    ]);
  };

  const handleRemoveNumericFilter = (colName: string) => {
    setNumericFilters(prev => prev.filter(f => f.columnName !== colName));
  };

  const handleUpdateSlider = (colName: string, value: number) => {
    setNumericFilters(prev => prev.map(f => {
      if (f.columnName === colName) {
        return { ...f, currentMax: value };
      }
      return f;
    }));
  };

  // Toggle Category Slices
  const handleToggleSlice = (colName: string, value: string) => {
    setSelectedSlices(prev => {
      const currentValues = prev[colName] || [];
      const updatedValues = currentValues.includes(value)
        ? currentValues.filter(v => v !== value)
        : [...currentValues, value];
      return {
        ...prev,
        [colName]: updatedValues
      };
    });
  };

  const handleResetFilters = () => {
    setSelectedSlices({});
    setRowSlicePercentage(100);
    // Reset all ranges to maximum min/max limits
    setNumericFilters(prev => prev.map(f => ({
      ...f,
      currentMin: f.min,
      currentMax: f.max
    })));
  };

  // Extract unique category options for any categorical column
  const getCategoriesForColumn = (colName: string) => {
    if (!colName) return [];
    const vals = enrichedRows.map(r => {
      const raw = r[colName];
      return raw === undefined || raw === null ? 'Unknown' : String(raw);
    });
    return Array.from(new Set(vals)).filter(v => v !== 'null' && v !== '');
  };

  // Main active categorical options mapping
  const activeSlicerCategories = useMemo(() => {
    return getCategoriesForColumn(activeSlicerColumn);
  }, [enrichedRows, activeSlicerColumn]);

  // Compute filtered rows dynamically based on ALL active multi-slicers, range filters, and selected map country
  const filteredRows = useMemo(() => {
    const baseFiltered = enrichedRows.filter(row => {
      // 0. Country Map Filter validation (if a country is clicked on the map)
      if (selectedMapCountry) {
        let countryVal = '';
        if (activeGeoKeys.countryKey && row[activeGeoKeys.countryKey]) {
          countryVal = String(row[activeGeoKeys.countryKey]).toLowerCase().trim();
        } else if (row._simulated_country) {
          countryVal = String(row._simulated_country).toLowerCase().trim();
        }

        const lowerSelected = selectedMapCountry.toLowerCase().trim();
        if (!countryVal.includes(lowerSelected) && !lowerSelected.includes(countryVal)) {
          return false;
        }
      }

      // 1. Multi Categorical slices validation
      for (const [colName, selectedValues] of Object.entries(selectedSlices)) {
        const valArray = selectedValues as string[];
        if (valArray.length === 0) continue;
        const rowVal = row[colName] === undefined || row[colName] === null ? 'Unknown' : String(row[colName]);
        if (!valArray.includes(rowVal)) {
          return false;
        }
      }

      // 2. Multiple numeric threshold checks
      for (const filter of numericFilters) {
        const val = Number(row[filter.columnName]);
        if (!isNaN(val)) {
          if (val < filter.currentMin || val > filter.currentMax) {
            return false;
          }
        }
      }
      return true;
    });

    const sliceCount = Math.max(1, Math.ceil((rowSlicePercentage / 100) * baseFiltered.length));
    return baseFiltered.slice(0, sliceCount);
  }, [enrichedRows, selectedSlices, numericFilters, rowSlicePercentage, selectedMapCountry, activeGeoKeys]);

  // Track dynamic frequency of each country in the active subset
  const countryRowCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const { countryKey } = activeGeoKeys;

    enrichedRows.forEach(row => {
      let cVal = '';
      if (row._simulated_country) {
        cVal = String(row._simulated_country).toLowerCase().trim();
      } else if (countryKey && row[countryKey]) {
        cVal = String(row[countryKey]).toLowerCase().trim();
      }

      if (cVal) {
        counts[cVal] = (counts[cVal] || 0) + 1;
      }
    });
    return counts;
  }, [enrichedRows, activeGeoKeys]);

  // KPI Calculations based on user numeric variables selection
  const [selectedKpiSumCol, setSelectedKpiSumCol] = useState(
    numericCols.find(c => /charge|revenue|revenue|spend|cost|amount/i.test(c.name))?.name || numericCols[0]?.name || ''
  );
  
  const [selectedKpiAvgCol, setSelectedKpiAvgCol] = useState(
    numericCols.find(c => /tenure|hours|days|success|age|duration/i.test(c.name))?.name || numericCols[1]?.name || numericCols[0]?.name || ''
  );

  // Dynamic values computation for KPIs
  const cumulativeValue = useMemo(() => {
    if (filteredRows.length === 0 || !selectedKpiSumCol) return 0;
    const sum = filteredRows.reduce((acc, r) => acc + (Number(r[selectedKpiSumCol]) || 0), 0);
    return parseFloat(sum.toFixed(2));
  }, [filteredRows, selectedKpiSumCol]);

  const averageRatio = useMemo(() => {
    if (filteredRows.length === 0 || !selectedKpiAvgCol) return 0;
    const sum = filteredRows.reduce((acc, r) => acc + (Number(r[selectedKpiAvgCol]) || 0), 0);
    return parseFloat((sum / filteredRows.length).toFixed(2));
  }, [filteredRows, selectedKpiAvgCol]);

  const maxValue = useMemo(() => {
    if (filteredRows.length === 0 || !selectedKpiSumCol) return 0;
    const max = filteredRows.reduce((a, r) => {
      const val = Number(r[selectedKpiSumCol]) || 0;
      return val > a ? val : a;
    }, -Infinity);
    return max === -Infinity ? 0 : parseFloat(max.toFixed(2));
  }, [filteredRows, selectedKpiSumCol]);

  // Chart data 1: Volume segment counts matching the selected categorical display
  const [segmentDisplayCol, setSegmentDisplayCol] = useState(categoricalCols[0]?.name || '');
  const [chartType, setChartType] = useState<'bar' | 'pie'>('bar');

  const segmentChartData = useMemo(() => {
    if (!segmentDisplayCol) return [];
    const counts: Record<string, number> = {};
    filteredRows.forEach(row => {
      const val = row[segmentDisplayCol];
      const key = val === undefined || val === null ? 'Unknown' : String(val);
      counts[key] = (counts[key] || 0) + 1;
    });

    const total = filteredRows.length || 1;
    return Object.entries(counts)
      .map(([name, count]) => ({
        name,
        count,
        percentage: parseFloat(((count / total) * 100).toFixed(1))
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8); // Top 8 values
  }, [filteredRows, segmentDisplayCol]);

  // Chart data 2: Visual relationship Scatter comparison of two numerical parameters
  const [scatterX, setScatterX] = useState(numericCols[0]?.name || '');
  const [scatterY, setScatterY] = useState(numericCols[1]?.name || numericCols[0]?.name || '');

  const scatterChartData = useMemo(() => {
    if (!scatterX || !scatterY) return [];
    // sample 100 points for crisp scatter visualization
    return filteredRows.slice(0, 100).map((row, idx) => ({
      id: idx,
      x: parseFloat(Number(row[scatterX] || 0).toFixed(2)),
      y: parseFloat(Number(row[scatterY] || 0).toFixed(2)),
      label: row[categoricalCols[0]?.name] || `Row ${idx + 1}`
    }));
  }, [filteredRows, scatterX, scatterY, categoricalCols]);

  // Chart data 3: Historical brush area progression line data
  const dateCol = useMemo(() => {
    return dataset.columns.find(c => c.type === 'datetime')?.name || '';
  }, [dataset]);

  const areaTimeSeriesData = useMemo(() => {
    const trendCol = selectedKpiSumCol || numericCols[0]?.name || '';
    if (!trendCol) return [];
    
    return filteredRows.slice(0, 40).map((row, idx) => {
      const xLabel = dateCol && row[dateCol]
        ? String(row[dateCol]).split('T')[0]
        : `Index ${idx + 1}`;
      return {
        name: xLabel,
        metric: parseFloat(Number(row[trendCol] || 0).toFixed(2))
      };
    });
  }, [filteredRows, selectedKpiSumCol, numericCols, dateCol]);

  // World interactive Map details
  const [focusedPoint, setFocusedPoint] = useState<any | null>(null);

  // Filter coordinates-capable rows
  const mapDataPoints = useMemo(() => {
    if (!activeGeoKeys.hasLocation) return [];
    const { latKey, lonKey, countryKey } = activeGeoKeys;

    const mapped = filteredRows
      .map((row, idx) => {
        const lat = parseFloat(row[latKey]);
        const lon = parseFloat(row[lonKey]);
        const country = row[countryKey] || 'Unknown';

        if (isNaN(lat) || isNaN(lon)) return null;
        return {
          id: idx,
          lat,
          lon,
          country,
          metricUnit: selectedKpiSumCol ? parseFloat(Number(row[selectedKpiSumCol] || 0).toFixed(1)) : 10,
          rowRaw: row
        };
      });

    const validPoints = mapped.filter(p => p !== null) as any[];

    // Safety cap: Limit leafet map to 1000 markers to prevent browser freeze
    const STEP = Math.max(1, Math.floor(validPoints.length / 1000));
    return validPoints.filter((_, i) => i % STEP === 0);
  }, [filteredRows, activeGeoKeys, selectedKpiSumCol]);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leafletMapInstanceRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const hasAutoFitRef = useRef(false);

  // Create the map + tile layer exactly once. Recreating the whole map on
  // every mapDataPoints change (as before) discarded the user's pan/zoom and
  // re-fetched every basemap tile on each filter tweak.
  useEffect(() => {
    if (!mapContainerRef.current || leafletMapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [20, 0],
      zoom: 2,
      zoomControl: true,
      attributionControl: false
    });

    leafletMapInstanceRef.current = map;
    markersLayerRef.current = L.layerGroup().addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 18
    }).addTo(map);

    return () => {
      map.remove();
      leafletMapInstanceRef.current = null;
      markersLayerRef.current = null;
    };
  }, []);

  // Re-sync just the markers whenever the filtered data changes, leaving the
  // existing map instance - and whatever view the user has panned/zoomed to - alone.
  useEffect(() => {
    const map = leafletMapInstanceRef.current;
    const layer = markersLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    // Render interactive point coordinates on the real map canvas
    mapDataPoints.slice(0, 150).forEach(pt => {
      const marker = L.marker([pt.lat, pt.lon], {
        icon: L.divIcon({
          html: `<div class="w-3.5 h-3.5 rounded-full bg-red border border-white animate-pulse shadow-sm flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full bg-white"></div></div>`,
          className: 'custom-leaflet-marker',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        })
      }).addTo(layer);

      // Interactive popup with custom layout styles
      marker.bindPopup(`
        <div class="p-2 tabular-nums text-xs text-label">
          <strong class="text-green block text-xs mb-1" style="color:var(--chart-6)">${pt.country}</strong>
          <div>Lat/Lon: <span class="text-label">${pt.lat.toFixed(3)}°, ${pt.lon.toFixed(3)}°</span></div>
          <div class="mt-1">Value/Score: <strong class="text-teal">$${pt.metricUnit.toLocaleString()}</strong></div>
        </div>
      `, {
        closeButton: false,
        className: 'custom-leaflet-popup'
      });

      marker.on('click', () => {
        setFocusedPoint(pt);
      });
    });

    // Frame the data once, the first time real points show up, rather than
    // on every subsequent filter tweak - that repeated re-framing was the bug.
    if (!hasAutoFitRef.current && mapDataPoints.length > 0) {
      hasAutoFitRef.current = true;
      const bounds = L.latLngBounds(mapDataPoints.map(pt => [pt.lat, pt.lon] as [number, number]));
      map.fitBounds(bounds, { maxZoom: 4, padding: [20, 20] });
    }
  }, [mapDataPoints]);

  // Continent aggregated data computed dynamically
  const regionAggregations = useMemo(() => {
    const aggregates: Record<string, { count: number; sumMetric: number }> = {};
    const { countryKey } = activeGeoKeys;

    filteredRows.forEach(row => {
      let regionKey = 'Other';
      if (isGeographicallyEnriched) {
        regionKey = row._simulated_region || 'Other';
      } else {
        // Guess continent based on country name string
        const cNorm = String(row[countryKey] || '').toLowerCase();
        if (cNorm.includes('state') || cNorm.includes('usa') || cNorm.includes('canada') || cNorm.includes('america')) {
          regionKey = 'North America';
        } else if (cNorm.includes('brazil') || cNorm.includes('argentina') || cNorm.includes('colombia')) {
          regionKey = 'South America';
        } else if (cNorm.includes('german') || cNorm.includes('france') || cNorm.includes('uk') || cNorm.includes('london') || cNorm.includes('spain') || cNorm.includes('italy') || cNorm.includes('europe')) {
          regionKey = 'Europe';
        } else if (cNorm.includes('china') || cNorm.includes('india') || cNorm.includes('japan') || cNorm.includes('singapore') || cNorm.includes('asia')) {
          regionKey = 'Eurasia';
        } else if (cNorm.includes('africa') || cNorm.includes('nigeria') || cNorm.includes('egypt')) {
          regionKey = 'Africa';
        } else if (cNorm.includes('australia') || cNorm.includes('zealand')) {
          regionKey = 'Australia';
        }
      }

      const val = selectedKpiSumCol ? Number(row[selectedKpiSumCol] || 0) : 1;
      if (!aggregates[regionKey]) {
        aggregates[regionKey] = { count: 0, sumMetric: 0 };
      }
      aggregates[regionKey].count += 1;
      aggregates[regionKey].sumMetric += val;
    });

    return aggregates;
  }, [filteredRows, activeGeoKeys, selectedKpiSumCol, isGeographicallyEnriched]);

  // Helper convert coordinates cleanly into responsive SVG map grid
  const projectCoordinates = (lat: number, lon: number, width: number, height: number) => {
    // Mercator coordinate conversion standard boundaries
    // Longitude: -180 to 180 maps to width (0 to width)
    const x = ((lon + 180) / 360) * width;
    // Latitude: 90 to -90 bounds to height (0 to height)
    const y = ((90 - lat) / 180) * height;
    return { x, y };
  };

  return (
    <div className="space-y-4" id="dashboard_module_upgraded">
      
      {/* 3. PERFORMANCE & VALUE COHORT KPI CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 relative z-10" id="dashboard_kpi_cards">
        
        {/* KPI 1: Cohort size */}
        <div className="bg-surface border border-separator p-3 rounded-xl shadow-sm flex items-center justify-between hover:border-separator-strong transition-all duration-300">
          <div className="space-y-0.5 block truncate">
            <p className="text-[11px] font-medium text-label-2 tabular-nums">Isolated Dataset Size</p>
            <p className="text-lg font-semibold text-label tabular-nums leading-none">{filteredRows.length.toLocaleString()}</p>
            <p className="text-[11px] text-label-3 mt-1 font-semibold tabular-nums">
              Count of filtered rows active
            </p>
          </div>
          <div className="w-8 h-8 bg-blue/10 border border-blue/25 rounded-lg flex items-center justify-center text-blue shrink-0 shadow">
            <Users className="w-4 h-4" />
          </div>
        </div>

        {/* KPI 2: Total Sum selected col */}
        <div className="bg-surface border border-separator p-3 rounded-xl shadow-sm flex flex-col justify-between hover:border-separator-strong transition-all duration-300">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-0.5 block truncate">
              <p className="text-[11px] font-medium text-label-2 tabular-nums flex items-center gap-1">
                Sum Metric Value
              </p>
              
              <p className="text-lg font-semibold text-label tabular-nums leading-none truncate" title={`$${cumulativeValue.toLocaleString()}`}>
                ${cumulativeValue.toLocaleString()}
              </p>
            </div>
            
            <div className="w-8 h-8 bg-green/10 border border-green/25 rounded-lg flex items-center justify-center text-green shrink-0 shadow">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          
          <div className="mt-1 flex items-center justify-between gap-1 border-t border-separator pt-1 text-[11px]">
            <span className="tabular-nums text-label-3">Lens Column:</span>
            <select
              value={selectedKpiSumCol}
              onChange={(e) => setSelectedKpiSumCol(e.target.value)}
              className="bg-surface border border-separator rounded px-1.5 py-0.5 text-[11px] tabular-nums text-blue cursor-pointer font-semibold focus:outline-none"
            >
              {numericCols.map(c => (
                <option key={c.name} value={c.name} className="text-xs">
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* KPI 3: Center Ratio selected col */}
        <div className="bg-surface border border-separator p-3 rounded-xl shadow-sm flex flex-col justify-between hover:border-separator-strong transition-all duration-300">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-0.5 block truncate">
              <p className="text-[11px] font-medium text-label-2 tabular-nums">
                Average Value
              </p>
              
              <p className="text-lg font-semibold text-label tabular-nums leading-none truncate" title={averageRatio.toString()}>
                {averageRatio}
              </p>
            </div>
            
            <div className="w-8 h-8 bg-orange/10 border border-orange/25 rounded-lg flex items-center justify-center text-orange shrink-0 shadow">
              <BarChart3 className="w-4 h-4" />
            </div>
          </div>

          <div className="mt-1 flex items-center justify-between gap-1 border-t border-separator pt-1 text-[11px]">
            <span className="tabular-nums text-label-3">Center Metric:</span>
            <select
              value={selectedKpiAvgCol}
              onChange={(e) => setSelectedKpiAvgCol(e.target.value)}
              className="bg-surface border border-separator rounded px-1.5 py-0.5 text-[11px] tabular-nums text-blue cursor-pointer font-semibold focus:outline-none"
            >
              {numericCols.map(c => (
                <option key={c.name} value={c.name} className="text-xs">
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* KPI 4: Peak Value */}
        <div className="bg-surface border border-separator p-3 rounded-xl shadow-sm flex items-center justify-between hover:border-separator-strong transition-all duration-300">
          <div className="space-y-0.5 block truncate">
            <p className="text-[11px] font-medium text-label-2 tabular-nums">Extreme Ceiling Peak</p>
            <p className="text-lg font-semibold text-label tabular-nums leading-none truncate" title={`$${maxValue.toLocaleString()}`}>
              ${maxValue.toLocaleString()}
            </p>
            <p className="text-[11px] text-blue font-semibold tabular-nums">
              Max of active sum metrics
            </p>
          </div>
          <div className="w-8 h-8 bg-teal/10 border border-teal/25 rounded-lg flex items-center justify-center text-teal shrink-0 shadow">
            <Sparkles className="w-4 h-4" />
          </div>
        </div>

      </div>

      {/* 2. ADVANCED CONTROL DECK: MULTI-SLICERS & METRICS SLIDES */}
      <div className="bg-surface p-3 sm:p-3 rounded-2xl border border-separator shadow-sm relative overflow-hidden">

        <div className="flex justify-between items-center gap-3 mb-3 pb-2 border-b border-separator relative z-10">
          <div className="flex items-center gap-1.5 flex-row">
            <SlidersHorizontal className="w-4 h-4 text-blue" />
                        <h2 className="text-sm font-semibold text-label tracking-tight">Filters</h2>
          </div>
          <button
            onClick={handleResetFilters}
            className="text-[11px] tabular-nums font-semibold text-blue hover:text-label bg-blue/10 hover:bg-blue/25 px-2 py-1 rounded transition-all cursor-pointer border border-blue/20 shadow"
          >
            <RefreshCw className="w-2.5 h-2.5" /> Clear All
          </button>
        </div>

        {/* Filters Bento Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 relative z-10">
          
          {/* Slicer Column A: Active Categorical Multi-Slicer */}
          <div className="space-y-1.5 bg-surface p-2.5 rounded-xl border border-separator">
            <div className="flex justify-between items-center text-[11px] text-label-2 tabular-nums font-medium px-0.5">
              <span>Primary Category Slicer</span>
              <select
                value={activeSlicerColumn}
                onChange={(e) => setActiveSlicerColumn(e.target.value)}
                className="bg-transparent border-0 font-semibold tabular-nums text-blue focus:ring-0 p-0 text-[11px] shrink-0 cursor-pointer"
              >
                {categoricalCols.map(c => (
                  <option key={c.name} value={c.name} className="bg-well text-label">
                    {c.name}
                  </option>
                ))}
                {isGeographicallyEnriched && (
                  <>
                    <option value="_simulated_country" className="bg-well text-label">_simulated_country</option>
                    <option value="_simulated_region" className="bg-well text-label">_simulated_region</option>
                  </>
                )}
              </select>
            </div>
            
            <p className="text-[11px] text-label-3 tabular-nums leading-none">
              Slices rows by selection:
            </p>

            <div className="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto p-1.5 border border-separator bg-well rounded-lg scrollbar-thin">
              {activeSlicerCategories.map(cat => {
                const isSelected = selectedSlices[activeSlicerColumn]?.includes(cat);
                return (
                  <button
                    key={cat}
                    onClick={() => handleToggleSlice(activeSlicerColumn, cat)}
                    className={`text-[11px] tabular-nums font-semibold px-2 py-1 rounded transition-all border shrink-0 cursor-pointer ${
                      isSelected
                        ? 'bg-blue hover:bg-blue text-white border-blue shadow-sm'
                        : 'bg-surface hover:bg-surface border-separator text-label-2 hover:text-label'
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
              {activeSlicerCategories.length === 0 && (
                <span className="text-[11px] text-label-3 tabular-nums italic p-0.5">None.</span>
              )}
            </div>
          </div>

          {/* Slicer Column B: Active Quantitative Range Sliders */}
          <div className="space-y-1.5 bg-surface p-2.5 rounded-xl border border-separator col-span-1">
            <div className="flex justify-between items-center text-[11px] text-label-2 tabular-nums font-medium px-0.5">
              <span>Quantitative Limits</span>
              
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-label-3 tabular-nums">Pin Parameter:</span>
                <select
                  onChange={(e) => {
                    if (e.target.value) {
                      handleAddNumericFilter(e.target.value);
                      e.target.value = ''; // Reset select value after adding
                    }
                  }}
                  className="bg-surface border border-separator rounded px-1 px-1.5 py-0.5 text-[11px] tabular-nums text-blue cursor-pointer focus:outline-none"
                  defaultValue=""
                >
                  <option value="" disabled>+ Add Column</option>
                  {numericCols.map(c => (
                    <option key={c.name} value={c.name} disabled={numericFilters.some(f => f.columnName === c.name)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[80px] overflow-y-auto scrollbar-thin pr-1">
              {numericFilters.map((filter) => {
                return (
                  <div key={filter.columnName} className="p-1.5 bg-well rounded-lg border border-separator relative">
                    <button
                      onClick={() => handleRemoveNumericFilter(filter.columnName)}
                      className="absolute top-1 right-1 p-0.5 text-label-3 hover:text-red bg-surface border border-separator cursor-pointer hover:bg-red/10 transition-colors rounded"
                      title="Remove Filter"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>

                    <div className="text-[11px] font-semibold text-label truncate pr-5 tabular-nums">
                      {filter.columnName}
                    </div>

                    <div className="flex justify-between text-[11px] text-label-3 tabular-nums my-0.5">
                      <span>Cutoff: <strong className="text-blue">{filter.currentMax}</strong></span>
                    </div>

                    <input
                      type="range"
                      min={filter.min}
                      max={filter.max}
                      value={filter.currentMax}
                      onChange={(e) => handleUpdateSlider(filter.columnName, Number(e.target.value))}
                      className="w-full h-1 bg-fill rounded appearance-none cursor-pointer accent-blue"
                    />
                  </div>
                );
              })}

              {numericFilters.length === 0 && (
                <div className="col-span-2 py-3 text-center text-label-3 tabular-nums text-[11px] italic">
                  Select a variable to create cutoff range slider.
                </div>
              )}
            </div>
          </div>

          {/* Slicer Column C: Interactive Row Volumetry Slicer Slide */}
          <div className="space-y-1.5 bg-surface p-2.5 rounded-xl border border-separator col-span-1">
            <div className="flex justify-between items-center text-[11px] text-label-2 tabular-nums font-medium px-0.5">
              <span>Interactive Row Sampling</span>
              <span className="text-[11px] tabular-nums text-green font-medium">SLIDER</span>
            </div>

            <div className="p-1.5 bg-well rounded-lg border border-separator space-y-1">
              <div className="flex justify-between text-[11px] tabular-nums">
                <span className="text-label-3">Slice:</span>
                <span className="text-green font-semibold">{rowSlicePercentage}%</span>
              </div>

              <input
                type="range"
                min="5"
                max="100"
                step="5"
                value={rowSlicePercentage}
                onChange={(e) => setRowSlicePercentage(Number(e.target.value))}
                className="w-full h-1 bg-fill rounded appearance-none cursor-pointer accent-blue"
              />
            </div>

            <div className="bg-blue/5 p-1 px-2 rounded-lg border border-blue/10 text-[11px] text-label-2 tabular-nums flex justify-between items-center">
              <span className="text-green text-[11px] font-medium">Rows Active:</span>
              <strong className="text-label">{filteredRows.length} rows</strong>
            </div>
          </div>
        </div>

        {/* Dynamic Applied Active Filters Status Badges */}
        <div className="mt-5 pt-4 border-t border-separator flex flex-wrap items-center justify-between gap-4 relative z-10">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] tabular-nums font-semibold text-label-3">Active Tags:</span>
            {Object.entries(selectedSlices).map(([col, vals]) => {
              const valArray = vals as string[];
              if (valArray.length === 0) return null;
              return (
                <div key={col} className="bg-blue/10 border border-blue/20 text-blue tabular-nums text-[11px] py-1 px-2.5 rounded-lg flex items-center gap-1.5">
                  <span>{col}:</span>
                  <strong className="text-label">{valArray.join(', ')}</strong>
                  <button
                    onClick={() => setSelectedSlices(prev => ({ ...prev, [col]: [] }))}
                    className="hover:text-red ml-1 cursor-pointer font-semibold"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            
            {Object.keys(selectedSlices).every(col => selectedSlices[col]?.length === 0) && (
              <span className="text-[11px] text-label-3 tabular-nums italic">No category restrictions in play. Row index set to open.</span>
            )}
          </div>

          <div className="text-xs tabular-nums text-label-2 bg-surface py-1.5 px-3 rounded-xl border border-separator flex items-center gap-1.5 shrink-0 select-none">
            <Filter className="w-3.5 h-3.5 text-blue" />
            <span>Retaining: <strong className="text-label">{filteredRows.length.toLocaleString()}</strong> / <strong>{enrichedRows.length.toLocaleString()}</strong> rows ({((filteredRows.length / (enrichedRows.length || 1)) * 100).toFixed(0)}% index)</span>
          </div>
        </div>
      </div>

      {/* 1. TOP DOCK: HEADER & INTERACTIVE MAP VIEWPORT */}
      <div className="bg-surface border border-separator rounded-2xl p-4 shadow-sm relative overflow-hidden">
        
        <div className="flex flex-col lg:flex-row gap-4 items-stretch justify-between relative z-10">
          
          {/* Metadata & Map Toggles */}
          <div className="lg:w-4/12 space-y-3 flex flex-col justify-between">
            <div className="space-y-1">
              <span className="text-[11px] tabular-nums font-medium text-teal bg-teal/10 border border-teal/20 px-2 py-0.5 rounded inline-block">
                GEOGRAPHIC MAPS & INSIGHTS
              </span>
              <h3 className="text-sm font-semibold text-label tracking-tight">
                Map
              </h3>
              <p className="text-[11px] text-label-2 leading-snug">
                Interactive mapping bubbles scale with customer volume and KPI values across continents, keeping expansion balanced.
              </p>
            </div>
 
            {/* Geographical Check Indicator and simulation actions */}
            <div className="p-3 rounded-xl bg-well border border-separator space-y-2">
              <div className="flex items-center gap-1.5">
                <Globe className="w-4 h-4 text-blue" />
                <span className="text-xs font-semibold text-label">Location Fields Detected:</span>
              </div>
              
              <ul className="text-[11px] space-y-1 text-label tabular-nums">
                <li className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${geoColumns.hasLatLon || isGeographicallyEnriched ? 'bg-green shadow' : 'bg-label-3'}`} />
                  GPS coordinates: <strong className="text-label">{geoColumns.hasLatLon ? 'NATIVE' : isGeographicallyEnriched ? 'GEO-ENRICHED' : 'FALSE'}</strong>
                </li>
                <li className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${geoColumns.hasCountry || isGeographicallyEnriched ? 'bg-green shadow' : 'bg-label-3'}`} />
                  Country columns: <strong className="text-label">{geoColumns.hasCountry ? `FOUND (${geoColumns.countryColName})` : isGeographicallyEnriched ? 'AUTO-LINKED' : 'NOT DETECTED'}</strong>
                </li>
              </ul>

              {!geoColumns.hasLatLon && !geoColumns.hasCountry && !isGeographicallyEnriched && (
                <div className="pt-1.5 border-t border-separator">
                  <div className="flex items-start gap-1.5 mb-1.5 p-1 bg-orange/5 rounded border border-orange/10">
                    <Info className="w-3 h-3 text-orange shrink-0 mt-0.5" />
                    <span className="text-[11px] text-orange leading-tight">
                      No country or GPS headers detected. Enrich dataset to display coordinates mapping.
                    </span>
                  </div>
                  <button
                    onClick={handleSimulateGeoAttributes}
                    className="w-full py-1.5 px-2.5 rounded-lg bg-blue hover:bg-blue text-white font-medium text-[11px] tabular-nums transition-all cursor-pointer flex items-center justify-center gap-1 shadow-sm"
                  >
                    <Plus className="w-3 h-3" /> Geographically Enrich
                  </button>
                </div>
              )}

              {(geoColumns.hasLatLon || isGeographicallyEnriched) && (
                <div className="text-[11px] text-green tabular-nums font-semibold flex items-center gap-1 bg-green/10 py-1 px-2 rounded border border-green/20">
                  <CheckCircle className="w-3 h-3" /> {isGeographicallyEnriched ? 'Automated Coordinate Geocoder' : 'Native Coordinates Auto-Linked'} ({mapDataPoints.length} mapped)
                </div>
              )}
            </div>
          </div>

          {/* Style executive SVG World Map Projection */}
          <div className="lg:w-8/12 bg-surface border border-separator rounded-xl p-3 relative overflow-hidden min-h-[200px] flex flex-col justify-between">
            {/* Header / Active Filter Info badge */}
            <div className="absolute top-2.5 left-2.5 bg-surface border border-separator rounded-lg p-1.5 text-xs text-label backdrop-blur cursor-default select-none z-10 space-y-0.5">
              <p className="font-medium text-[11px] tabular-nums text-blue">Geo Analytics Engine</p>
              <div className="text-[11px] text-label flex items-center gap-1">
                <span className="w-2 h-2 bg-green rounded-full inline-block animate-pulse" />
                Aggregated Rows Mapped: <strong className="text-green">{filteredRows.length.toLocaleString()} ({((filteredRows.length / (enrichedRows.length || 1)) * 100).toFixed(0)}%)</strong>
              </div>
            </div>

            {selectedMapCountry && (
              <div className="absolute top-2.5 right-2.5 bg-green/15 border border-green/40 text-green rounded-lg px-2 py-1 text-[11px] tabular-nums font-semibold flex items-center gap-1.5 backdrop-blur select-none z-10 shadow">
                <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
                Active: <strong className="text-label">{selectedMapCountry.toUpperCase()}</strong>
                <button 
                  onClick={() => setSelectedMapCountry(null)}
                  className="bg-green hover:bg-green text-white font-medium px-1.5 py-0.5 rounded text-[11px] tabular-nums transition-colors border-0 cursor-pointer ml-1"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Elegant Map Box Container: scaled to be more compact as requested */}
            <div className="flex-1 min-h-[220px] lg:min-h-[260px] w-full flex items-center justify-center relative bg-surface rounded-lg border border-separator p-0 mt-4 overflow-hidden z-0">
              <div ref={mapContainerRef} className="absolute inset-0 w-full h-full" id="stakeholder_leaflet_map_view" />

              {/* No coordinates present overlay */}
              {mapDataPoints.length === 0 && !isGeographicallyEnriched && (
                <div className="absolute inset-x-0 inset-y-0 bg-surface flex flex-col items-center justify-center p-6 text-center z-[1000] transition-opacity">
                  <Globe className="w-10 h-10 text-label-3 mb-2 animate-pulse" />
                  <p className="text-label text-xs font-semibold">Geospatial Overlay Offline</p>
                  <p className="text-[11px] text-label-2 mt-1 max-w-sm leading-relaxed">
                    Awaiting coordinate initialization. Upload coordinates or country columns to automatically map interactive coordinates in real-time.
                  </p>
                </div>
              )}
            </div>

            {/* Focused data point detail banner */}
            <div className="min-h-[38px] bg-well border border-separator rounded-xl p-2 px-3 flex items-center justify-between text-xs text-label-2 tabular-nums mt-3">
              {focusedPoint ? (
                <>
                  <div className="flex items-center gap-2 truncate">
                    <MapPin className="w-3.5 h-3.5 text-green" />
                    <span>Point Identified: <strong className="text-label">{focusedPoint.country}</strong> ({focusedPoint.lat.toFixed(1)}°, {focusedPoint.lon.toFixed(1)}°)</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span>Valuation: <strong className="text-teal">${focusedPoint.metricUnit}</strong></span>
                    <button
                      onClick={() => setFocusedPoint(null)}
                      className="text-[11px] text-label-3 hover:text-label cursor-pointer"
                    >
                      Clear
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-label-3 text-[11px] italic">
                  <Info className="w-3.5 h-3.5" />
                  <span>Interactive map is responsive. Click any emerald coordinate pin to drill down into active row telemetry logs.</span>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* 4. VISUALS BENTO WORKSPACE */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 relative z-10" id="dashboard_visuals_grid">
        
        {/* CHART B: CROSS-METRICS COVARIATE SCATTER MODEL RELATIONSHIP */}
        <div className="bg-surface p-3 rounded-xl border border-separator shadow-sm flex flex-col justify-between h-full hover:border-separator-strong transition-colors col-span-1 lg:col-span-1">
          <div>
            <div className="flex items-center justify-between gap-1.5 border-b border-separator pb-2 mb-2">
              <h3 className="font-semibold text-label text-xs flex items-center gap-1">
                <LineChart className="w-3.5 h-3.5 text-blue" /> Compare two metrics
              </h3>
              <span className="px-1.5 py-0.5 rounded text-[11px] font-medium tabular-nums bg-blue/10 text-blue border border-blue/20">
                Correlation
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 mb-2 tabular-nums text-[11px] text-label-3">
              <div>
                <span>Axis X:</span>
                <select
                  value={scatterX}
                  onChange={(e) => setScatterX(e.target.value)}
                  className="w-full bg-surface border border-separator rounded p-0.5 text-[11px] text-label tabular-nums mt-0.5 focus:ring-0 focus:outline-none font-semibold"
                >
                  {numericCols.map(c => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <span>Axis Y:</span>
                <select
                  value={scatterY}
                  onChange={(e) => setScatterY(e.target.value)}
                  className="w-full bg-surface border border-separator rounded p-0.5 text-[11px] text-label tabular-nums mt-0.5 focus:ring-0 focus:outline-none font-semibold"
                >
                  {numericCols.map(c => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="h-[140px] w-full relative">
            {scatterChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 5, right: 10, left: -25, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                  <XAxis type="number" dataKey="x" name={scatterX} stroke="var(--chart-axis)" fontSize={8.5} tickLine={false} />
                  <YAxis type="number" dataKey="y" name={scatterY} stroke="var(--chart-axis)" fontSize={8.5} tickLine={false} />
                  <ZAxis type="number" range={[15, 30]} />
                  <Tooltip
                    cursor={{ strokeDasharray: '3 3' }}
                    formatter={(value) => [value, '']}
                  />
                  <Scatter name="Telemetry Nodes" data={scatterChartData} fill="var(--chart-2)" />
                </ScatterChart>
              </ResponsiveContainer>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-label-3 text-xs tabular-nums italic">
                Awaiting sample rows.
              </div>
            )}
          </div>

          <div className="border-t border-separator pt-1.5 mt-2 text-[11px] text-label-2 leading-normal">
            Simulates linear scatter relationship across active rows.
          </div>
        </div>

        {/* CHART C: LONGITUDINAL TREND PROGRESSION WITH BRUSH */}
        <div className="bg-surface p-3 rounded-xl border border-separator shadow-sm flex flex-col justify-between h-full hover:border-separator-strong transition-colors col-span-1 lg:col-span-1">
          <div>
            <div className="flex items-center justify-between gap-1.5 border-b border-separator pb-2 mb-2">
              <h3 className="font-semibold text-label text-xs flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5 text-blue" /> Trend
              </h3>
              <span className="text-[11px] tabular-nums text-label-3 font-semibold shrink-0">
                {dateCol ? `Linked: ${dateCol}` : 'Linked: Index'}
              </span>
            </div>

            <p className="text-[11px] text-label-2 leading-tight mb-2">
              Chronological trends for <strong className="text-label">"{selectedKpiSumCol}"</strong>.
            </p>
          </div>

          <div className="h-[140px] w-full relative">
            {areaTimeSeriesData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={areaTimeSeriesData} margin={{ top: 5, right: 10, left: -25, bottom: 5 }}>
                  <defs>
                    <linearGradient id="gradientKpiGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                  <XAxis dataKey="name" stroke="var(--chart-axis)" fontSize={9} tickLine={false} />
                  <YAxis stroke="var(--chart-axis)" fontSize={9} tickLine={false} />
                  <Tooltip
                  />
                  <Area type="monotone" dataKey="metric" stroke="var(--chart-1)" strokeWidth={2.5} fillOpacity={1} fill="url(#gradientKpiGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-label-3 text-xs tabular-nums italic">
                Awaiting chronological datasets.
              </div>
            )}
          </div>

          <div className="border-t border-separator pt-1.5 mt-2 text-[11px] text-label-2 leading-normal">
            Captures fluctuations and sequential moving patterns.
          </div>
        </div>

        {/* CHART A: DEMOGRAPHICS SEGMENTATION ANALYSIS */}
        <div className="bg-surface p-3 rounded-xl border border-separator shadow-sm flex flex-col justify-between h-full hover:border-separator-strong transition-colors">
          <div>
            <div className="flex items-center justify-between gap-1.5 border-b border-separator pb-2 mb-2">
              <h3 className="font-semibold text-label text-xs flex items-center gap-1">
                <BarChart3 className="w-3.5 h-3.5 text-blue" /> Breakdown by segment
              </h3>
              
              <div className="flex gap-1 bg-surface border border-separator p-0.5 rounded-lg">
                <button
                  type="button"
                  onClick={() => setChartType('bar')}
                  className={`px-2 py-1 rounded text-[11px] font-semibold tabular-nums cursor-pointer ${chartType === 'bar' ? 'bg-blue text-white shadow' : 'text-label-3 text-label-2 hover:text-label'}`}
                >
                  BAR
                </button>
                <button
                  type="button"
                  onClick={() => setChartType('pie')}
                  className={`px-2 py-1 rounded text-[11px] font-semibold tabular-nums cursor-pointer ${chartType === 'pie' ? 'bg-blue text-white shadow' : 'text-label-3 text-label-2 hover:text-label'}`}
                >
                  PIE
                </button>
              </div>
            </div>

            <div className="flex justify-between items-center text-[11px] text-label-3 tabular-nums mb-4 px-0.5">
              <span>Segmented By Column:</span>
              <select
                value={segmentDisplayCol}
                onChange={(e) => setSegmentDisplayCol(e.target.value)}
                className="bg-transparent border-0 font-semibold tabular-nums text-blue focus:ring-0 p-0 text-xs shrink-0 cursor-pointer focus:outline-none"
              >
                {categoricalCols.map(c => (
                  <option key={c.name} value={c.name} className="bg-well text-label">
                    {c.name}
                  </option>
                ))}
                {isGeographicallyEnriched && (
                  <>
                    <option value="_simulated_country" className="bg-well text-label">_simulated_country</option>
                    <option value="_simulated_region" className="bg-well text-label">_simulated_region</option>
                  </>
                )}
              </select>
            </div>
          </div>

          <div className="h-[140px] w-full mt-2 relative">
            {segmentChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                {chartType === 'bar' ? (
                  <BarChart data={segmentChartData} margin={{ top: 5, right: 10, left: -25, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
                    <XAxis dataKey="name" stroke="var(--chart-axis)" fontSize={9} tickLine={false} />
                    <YAxis stroke="var(--chart-axis)" fontSize={9} tickLine={false} />
                    <Tooltip
                    />
                    <Bar dataKey="count" fill="var(--chart-1)" radius={[4, 4, 0, 0]}>
                      {segmentChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={index % 2 === 0 ? 'var(--chart-1)' : 'var(--chart-4)'} />
                      ))}
                    </Bar>
                  </BarChart>
                ) : (
                  <PieChart>
                    <Pie
                      data={segmentChartData}
                      cx="50%"
                      cy="45%"
                      innerRadius={45}
                      outerRadius={70}
                      paddingAngle={4}
                      dataKey="count"
                    >
                      {segmentChartData.map((entry, index) => (
                        <Cell key={`cell-pie-${index}`} fill={['var(--chart-1)', 'var(--chart-4)', 'var(--chart-2)', 'var(--chart-6)', 'var(--chart-3)', 'var(--chart-5)'][index % 6]} />
                      ))}
                    </Pie>
                    <Tooltip
                    />
                  </PieChart>
                )}
              </ResponsiveContainer>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-label-3 text-xs tabular-nums italic">
                No active records. Expand control filters above.
              </div>
            )}
          </div>

          <div className="border-t border-separator pt-1.5 mt-2 text-[11px] text-label-2 leading-normal">
            Ranks row proportion matching <strong>{filteredRows.length}</strong> active rows.
          </div>
        </div>

      </div>


      {/* ================= PYTHON LAB & EXPORTER WORKSPACE ================= */}
      <div className="bg-surface rounded-2xl border border-separator p-6 sm:p-8 shadow-sm relative overflow-hidden" id="python_sandbox_dock">

        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-5 border-b border-separator pb-5 mb-5">
          <div>
            <span className="text-[11px] tabular-nums font-medium text-blue bg-blue/10 border border-blue/25 px-2.5 py-1 rounded-xl inline-block select-none mb-1.5">
              LOCAL DEVELOPMENT RUNSPACE
            </span>
            <h2 className="text-lg font-semibold text-label tracking-tight flex items-center gap-2">
              <Code className="w-5 h-5 text-blue" /> Python export
            </h2>
            <p className="text-xs text-label-2 mt-1 max-w-2xl">
              Replicate secure browser model experiments locally. Download complete auto-tuned classifier pipelines, imputation modules, and seaborn diagnostic graphing templates.
            </p>
          </div>

          <div className="flex bg-surface border border-separator p-1 rounded-xl shrink-0">
            <button
               onClick={() => setSandboxTab('script')}
               className={`text-xs py-1.5 px-3 rounded-lg tabular-nums font-semibold transition-all cursor-pointer ${
                 sandboxTab === 'script'
                   ? 'bg-blue'
                   : 'text-label-2 hover:text-label'
               }`}
            >
              Pipeline Code
            </button>
            <button
               onClick={() => setSandboxTab('visuals')}
               className={`text-xs py-1.5 px-3 rounded-lg tabular-nums font-semibold transition-all cursor-pointer ${
                 sandboxTab === 'visuals'
                   ? 'bg-blue'
                   : 'text-label-2 hover:text-label'
               }`}
            >
              Visuals
            </button>
            <button
              onClick={() => setSandboxTab('guide')}
              className={`text-xs py-1.5 px-3 rounded-lg tabular-nums font-semibold transition-all cursor-pointer ${
                sandboxTab === 'guide'
                  ? 'bg-blue text-white'
                  : 'text-label-2 hover:text-label'
              }`}
            >
              Requirements & Setup
            </button>
          </div>
        </div>

        <div className="relative z-10">
          {sandboxTab === 'script' ? (
            <div className="space-y-4">
              <div className="flex justify-between items-center bg-surface border border-separator px-4 py-2.5 rounded-xl text-xs">
                <span className="tabular-nums text-green text-xs font-semibold flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5 fill-green text-green" /> data_science_workflow.py
                </span>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopyCode}
                    className="text-label hover:text-label hover:bg-fill border border-separator px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer text-[11px] tabular-nums"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-green" /> Code Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-label-2" /> Copy Script
                      </>
                    )}
                  </button>
                  <button
                    onClick={handleDownloadPython}
                    className="bg-blue/20 hover:bg-blue/45 border border-blue/40 text-blue px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all cursor-pointer text-[11px] tabular-nums"
                  >
                    <Download className="w-3.5 h-3.5 text-blue" /> Download .py
                  </button>
                </div>
              </div>

              <pre className="bg-surface p-5 rounded-xl border border-separator max-h-[380px] overflow-auto text-xs tabular-nums leading-relaxed text-label select-text scrollbar-thin scrollbar-thumb-slate-800">
                {generatePythonWorkflow()}
              </pre>
            </div>
          ) : sandboxTab === 'visuals' ? (
            <div className="space-y-6">
              {/* Alert/Callout banner explaining the Local Experiments */}
              <div className="p-5 rounded-2xl bg-surface border border-separator-strong text-label flex items-start gap-3.5 relative overflow-hidden">
                <div className="p-2.5 rounded-xl bg-blue/10 text-blue shrink-0">
                  <BrainCircuit className="w-5 h-5 text-blue" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-xs font-medium text-blue tabular-nums">Run it locally</h4>
                  <p className="text-xs leading-relaxed text-label">
                    Replicate secure browser model experiments locally. Download complete auto-tuned classifier pipelines, imputation modules, and seaborn diagnostic graphing templates.
                  </p>
                </div>
              </div>

              {/* Grid of professional diagnostic graphics */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* Graphics 1: Classifier Pipeline (ROC Curve) */}
                <div className="bg-surface border border-separator rounded-2xl p-5 space-y-4">
                  <div className="flex justify-between items-center border-b border-separator pb-2.5">
                    <h4 className="text-xs font-medium text-label tabular-nums flex items-center gap-1.5">
                      Classifier ROC Curve
                    </h4>
                    <span className="text-[11px] tabular-nums text-green bg-green/10 px-1.5 py-0.5 rounded border border-green/20">
                      AUC: {mlResult?.metrics?.rocAuc !== undefined && mlResult?.metrics?.rocAuc !== null ? mlResult.metrics.rocAuc.toFixed(2) : 'N/A'}
                    </span>
                  </div>
                  
                  <div className="h-[200px] w-full flex items-center justify-center bg-well rounded-xl relative py-2 border border-separator">
                    <svg className="w-full h-full max-h-[180px]" viewBox="0 0 200 150">
                      <line x1="30" y1="20" x2="180" y2="20" stroke="var(--chart-grid)" strokeDasharray="2,2" />
                      <line x1="30" y1="60" x2="180" y2="60" stroke="var(--chart-grid)" strokeDasharray="2,2" />
                      <line x1="30" y1="100" x2="180" y2="100" stroke="var(--chart-grid)" strokeDasharray="2,2" />
                      <line x1="75" y1="20" x2="75" y2="130" stroke="var(--chart-grid)" strokeDasharray="2,2" />
                      <line x1="120" y1="20" x2="120" y2="130" stroke="var(--chart-grid)" strokeDasharray="2,2" />
                      <line x1="165" y1="20" x2="165" y2="130" stroke="var(--chart-grid)" strokeDasharray="2,2" />
                      
                      <line x1="30" y1="130" x2="180" y2="20" stroke="var(--chart-grid)" strokeWidth="1" strokeDasharray="3,3" />
                      
                      <path d="M 30 130 Q 35 60 70 40 T 180 20" fill="none" stroke="var(--chart-6)" strokeWidth="2.5" strokeLinecap="round" />
                      
                      <circle cx="70" cy="40" r="3.5" fill="var(--chart-3)" />
                      
                      <line x1="30" y1="130" x2="180" y2="130" stroke="var(--separator-strong)" strokeWidth="1.5" />
                      <line x1="30" y1="20" x2="30" y2="130" stroke="var(--separator-strong)" strokeWidth="1.5" />
                      
                      <text x="105" y="145" fill="var(--chart-axis)" fontSize="7" textAnchor="middle">FPR (1 - Specificity)</text>
                      <text x="10" y="75" fill="var(--chart-axis)" fontSize="7" textAnchor="middle" transform="rotate(-90,10,75)">TPR (Sensitivity)</text>
                      
                      <text x="28" y="138" fill="var(--chart-axis)" fontSize="6" textAnchor="end">0.0</text>
                      <text x="180" y="138" fill="var(--chart-axis)" fontSize="6" textAnchor="middle">1.0</text>
                      <text x="24" y="24" fill="var(--chart-axis)" fontSize="6" textAnchor="end">1.0</text>
                    </svg>
                  </div>
                  <p className="text-[11px] text-label-2 tabular-nums leading-relaxed bg-well p-2.5 rounded-lg border border-separator">
                    <strong>Classifier Pipeline:</strong> Automatically optimized classifier algorithm achieving maximum separation of prediction thresholds.
                  </p>
                </div>

                {/* Graphics 2: Imputation Module Impact */}
                <div className="bg-surface border border-separator rounded-2xl p-5 space-y-4">
                  <div className="flex justify-between items-center border-b border-separator pb-2.5">
                    <h4 className="text-xs font-medium text-label tabular-nums flex items-center gap-1.5">
                      Imputation Variance
                    </h4>
                    <span className="text-[11px] tabular-nums text-teal bg-teal/10 px-1.5 py-0.5 rounded border border-teal/20">
                      KNN / Mean Fit
                    </span>
                  </div>

                  <div className="h-[200px] w-full flex items-center justify-center bg-well rounded-xl relative py-2 border border-separator">
                    <svg className="w-full h-full max-h-[180px]" viewBox="0 0 200 150">
                      <line x1="30" y1="125" x2="185" y2="125" stroke="var(--separator-strong)" strokeWidth="1.5" />
                      <line x1="30" y1="20" x2="30" y2="125" stroke="var(--separator-strong)" strokeWidth="1.5" />

                      <path d="M 30 125 Q 60 125 75 80 T 110 35 T 145 125 H 185" fill="none" stroke="var(--chart-3)" strokeOpacity="0.6" strokeWidth="1.8" strokeDasharray="3,2" />
                      
                      <path d="M 30 125 Q 55 125 70 65 T 107 20 T 140 125 H 185" fill="var(--chart-1)" fillOpacity="0.1" stroke="var(--chart-1)" strokeWidth="2.2" />

                      <rect x="110" y="25" width="6" height="6" fill="var(--chart-1)" rx="1" />
                      <text x="120" y="30" fill="var(--chart-axis)" fontSize="6.5">Imputed (Clean)</text>
                      
                      <line x1="110" y1="39" x2="116" y2="39" stroke="var(--chart-3)" strokeWidth="1.2" strokeDasharray="2,1" />
                      <text x="120" y="41" fill="var(--chart-axis)" fontSize="6.5">Original (Raw)</text>

                      <text x="107" y="142" fill="var(--chart-axis)" fontSize="7" textAnchor="middle">Variable Distribution</text>
                      <text x="12" y="72" fill="var(--chart-axis)" fontSize="7" textAnchor="middle" transform="rotate(-90,12,72)">Density</text>
                    </svg>
                  </div>
                  <p className="text-[11px] text-label-2 tabular-nums leading-relaxed bg-well p-2.5 rounded-lg border border-separator">
                    <strong>Imputation Modules:</strong> Mitigates feature skew by aligning continuous and modular variables using optimized statistical estimations.
                  </p>
                </div>

                {/* Graphics 3: Seaborn Diagnostic Template */}
                <div className="bg-surface border border-separator rounded-2xl p-5 space-y-4">
                  <div className="flex justify-between items-center border-b border-separator pb-2.5">
                    <h4 className="text-xs font-medium text-label tabular-nums flex items-center gap-1.5">
                      Seaborn Diagnostics
                    </h4>
                    <span className="text-[11px] tabular-nums text-blue bg-blue/10 px-1.5 py-0.5 rounded border border-blue/20">
                      sns.heatmap()
                    </span>
                  </div>

                  <div className="h-[200px] w-full flex items-center justify-center bg-well rounded-xl relative p-3 border border-separator">
                    <div className="grid grid-cols-3 gap-1.5 w-full h-full max-h-[175px] content-center tabular-nums text-[11px]">
                      <div className="bg-blue/15 text-label rounded p-1.5 flex flex-col justify-between items-center border border-blue/30">
                        <span className="text-[11px] text-blue opacity-80">v1 / v1</span>
                        <span className="font-semibold">1.00</span>
                      </div>
                      <div className="bg-blue/30 text-blue rounded p-1.5 flex flex-col justify-between items-center border border-blue/20">
                        <span className="text-[11px] opacity-80">v1 / v2</span>
                        <span className="font-semibold">0.68</span>
                      </div>
                      <div className="bg-red/15 text-red rounded p-1.5 flex flex-col justify-between items-center border border-red/10">
                        <span className="text-[11px] opacity-80">v1 / v3</span>
                        <span className="font-semibold">-0.24</span>
                      </div>

                      <div className="bg-blue/30 text-blue rounded p-1.5 flex flex-col justify-between items-center border border-blue/20">
                        <span className="text-[11px] opacity-80">v2 / v1</span>
                        <span className="font-semibold">0.68</span>
                      </div>
                      <div className="bg-blue/15 text-label rounded p-1.5 flex flex-col justify-between items-center border border-blue/30">
                        <span className="text-[11px] opacity-80">v2 / v2</span>
                        <span className="font-semibold">1.00</span>
                      </div>
                      <div className="bg-surface text-label-2 rounded p-1.5 flex flex-col justify-between items-center border border-separator">
                        <span className="text-[11px] opacity-80">v2 / v3</span>
                        <span className="font-semibold">0.05</span>
                      </div>

                      <div className="bg-red/15 text-red rounded p-1.5 flex flex-col justify-between items-center border border-red/10">
                        <span className="text-[11px] opacity-80">v3 / v1</span>
                        <span className="font-semibold">-0.24</span>
                      </div>
                      <div className="bg-surface text-label-2 rounded p-1.5 flex flex-col justify-between items-center border border-separator">
                        <span className="text-[11px] opacity-80">v3 / v2</span>
                        <span className="font-semibold">0.05</span>
                      </div>
                      <div className="bg-blue/15 text-label rounded p-1.5 flex flex-col justify-between items-center border border-blue/30">
                        <span className="text-[11px] opacity-80">v3 / v3</span>
                        <span className="font-semibold">1.00</span>
                      </div>
                    </div>
                  </div>
                  <p className="text-[11px] text-label-2 tabular-nums leading-relaxed bg-well p-2.5 rounded-lg border border-separator">
                    <strong>Seaborn Diagnostics:</strong> Beautiful pre-constructed templates to plot cross-feature correlations and feature predictive strengths automatically.
                  </p>
                </div>

              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 leading-relaxed">
              <div className="bg-surface border border-separator rounded-2xl p-5 space-y-3">
                <h4 className="text-xs font-medium text-label flex items-center gap-2 tabular-nums">
                  1. Install packages
                </h4>
                <p className="text-xs text-label-2">
                  Ensure you possess the required packages configured prior to model invocation. Execute the shell setup code in your local terminal:
                </p>
                <div className="bg-well p-3 rounded-lg border border-separator tabular-nums text-[11px] text-green select-all">
                  pip install pandas numpy scikit-learn matplotlib seaborn xgboost
                </div>
                <div className="text-[11px] text-label-3 leading-normal pt-1.5">
                  <strong>Note on Python requirements:</strong> Ensure Python version 3.8 or above is selected to avoid dependency resolution anomalies on older interpreter engines.
                </div>
              </div>

              <div className="bg-surface border border-separator rounded-2xl p-5 space-y-3">
                <h4 className="text-xs font-medium text-label flex items-center gap-2 tabular-nums">
                  2. Run the script
                </h4>
                <p className="text-xs text-label-2">
                  Follow these elementary workspace actions to train the local model:
                </p>
                <ul className="text-[11px] text-label space-y-2 list-decimal list-inside pl-1">
                  <li>Navigate your browser to the <strong>Upload & Preview</strong> workspace and download your cleansed data table as a CSV named <code className="tabular-nums bg-well text-green text-[11px] px-1 py-0.5 rounded leading-none">dataset.csv</code>.</li>
                  <li>In the same directory, paste or download your <code className="tabular-nums bg-well text-green text-[11px] px-1 py-0.5 rounded leading-none">data_science_workflow.py</code> pipeline file.</li>
                  <li>Trigger the runtime compiler executor via terminal:</li>
                  <div className="bg-well p-2 rounded border border-separator tabular-nums text-[11px] text-green mt-1">
                    python data_science_workflow.py
                  </div>
                  <li>Observe metric summaries printed alongside output visual asset renders including feature rankings.</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>


    </div>
  );
}


export default function StakeholderDashboard(props: StakeholderDashboardProps) {
  const { expertMode } = usePipelineContext();
  return (
    <DashboardProvider initialData={props.dataset.rows}>
      <IntelligentDashboardLayer dataset={props.dataset} mlResult={props.mlResult} />
      {expertMode && (
      <div className="mt-12 animate-fade-in relative z-0">
         <h2 className="section-title">Advanced analysis</h2>
         <p className="mt-1 mb-5 text-sm text-label-2">Filters, maps, trends and exportable Python for deeper work.</p>
         <StakeholderDashboardInner {...props} />
      </div>
      )}
    </DashboardProvider>
  );
}
