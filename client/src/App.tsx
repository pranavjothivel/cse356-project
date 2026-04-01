import { BrowserRouter, Route, Routes } from 'react-router-dom';

import './App.css';
import { AuthContextProvider } from './auth';

import HomeScreen from './components/HomeScreen';
import LoginScreen from './components/LoginScreen';


export default function App() {
  return (
    <BrowserRouter>
      <AuthContextProvider>
        <Routes>
          <Route path="/" element={<HomeScreen/>}/>
          <Route path="/login/" element={<LoginScreen/>}/>
        </Routes>
      </AuthContextProvider>
    </BrowserRouter>
  )
}