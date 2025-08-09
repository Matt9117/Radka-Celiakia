import React, { useState, useRef, useEffect } from 'react';
import { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat, Result } from '@zxing/library';

const App: React.FC = () => {
  const [barcode, setBarcode] = useState('');
  const [loading, setLoading] = useState(false);
  const [product, setProduct] = useState<any>(null);
  const [scanning, setScanning] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processingRef = useRef(false);
  const manualEditRef = useRef(false);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);

  const fetchProduct = async (code: string) => {
    setLoading(true);
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v0/product/${code}.json`);
      const data = await res.json();
      setProduct(data.product || null);
    } catch {
      setProduct(null);
    } finally {
      setLoading(false);
    }
  };

  const stopStream = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    if (scanning) {
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]);

      const reader = new BrowserMultiFormatReader(hints as any);
      readerRef.current = reader;

      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then((stream) => {
          streamRef.current = stream;
          if (videoRef.current) videoRef.current.srcObject = stream;

          reader.decodeFromVideoDevice(null, videoRef.current!, (res?: Result) => {
            if (!res) return;
            const code = res.getText();

            if (!manualEditRef.current) {
              setBarcode(code);
            }

            processingRef.current = true;
            try { navigator.vibrate?.(50) } catch {}
            setScanning(false);

            setTimeout(() => {
              fetchProduct(code).finally(() => {
                processingRef.current = false;
              });
            }, 80);
          });
        })
        .catch(console.error);

      return () => {
        reader.reset();
        stopStream();
      };
    } else {
      readerRef.current?.reset();
      stopStream();
    }
  }, [scanning]);

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '1rem', background: '#f7f7f7', minHeight: '100vh' }}>
      <h1 style={{ color: '#333', textAlign: 'center' }}>Radka Scanner</h1>

      {scanning && (
        <video
          ref={videoRef}
          style={{ width: '100%', borderRadius: '8px', marginBottom: '1rem' }}
          autoPlay
          muted
        />
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <input
          style={{ flex: 1, padding: '0.5rem', fontSize: '1rem', borderRadius: '4px', border: '1px solid #ccc' }}
          placeholder="Zadaj EAN/UPC kód"
          value={barcode}
          onChange={(e) => {
            manualEditRef.current = true;
            setBarcode(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (!barcode || loading || processingRef.current) return;
              manualEditRef.current = true;
              processingRef.current = true;
              fetchProduct(barcode).finally(() => {
                processingRef.current = false;
              });
            }
          }}
        />
        <button
          style={{ padding: '0.5rem 1rem', fontSize: '1rem', background: '#1976d2', color: '#fff', border: 'none', borderRadius: '4px' }}
          onClick={() => {
            if (!barcode || loading || processingRef.current) return;
            manualEditRef.current = true;
            processingRef.current = true;
            fetchProduct(barcode).finally(() => {
              processingRef.current = false;
            });
          }}
        >
          Vyhľadať
        </button>
      </div>

      <button
        style={{
          width: '100%',
          padding: '0.75rem',
          fontSize: '1rem',
          background: scanning ? '#d32f2f' : '#388e3c',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          marginBottom: '1rem'
        }}
        onClick={() => {
          if (scanning) {
            setScanning(false);
          } else {
            processingRef.current = false;
            manualEditRef.current = false;
            setScanning(true);
          }
        }}
      >
        {scanning ? 'Stop' : 'Spustiť kameru'}
      </button>

      {loading && <p>Načítavam údaje…</p>}
      {product && (
        <div style={{ background: '#fff', padding: '1rem', borderRadius: '8px', boxShadow: '0 0 8px rgba(0,0,0,0.1)' }}>
          <h2>{product.product_name || 'Neznámy produkt'}</h2>
          {product.image_url && (
            <img src={product.image_url} alt={product.product_name} style={{ width: '100%', borderRadius: '4px' }} />
          )}
        </div>
      )}
    </div>
  );
};

export default App;
