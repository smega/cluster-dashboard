import { h, render } from 'preact';
import App from './App.jsx';
import './index.css';       // 🔥 this is critical

render(<App />, document.getElementById('root'));
