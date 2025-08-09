import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';           // App.tsx je v tom istom priečinku src
import './styles.css';            // ak máš iný názov CSS, uprav cestu

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
