import { useState, useEffect, useContext } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import AuthContext from "../auth";

export default function LoginScreen() {
    const { auth } = useContext(AuthContext);
    const navigate = useNavigate();

    const [searchParams] = useSearchParams();

    const [oauth, setOAuth] = useState(searchParams.get('oauth') !== null);

    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");

    const [err, setErr] = useState("");

    useEffect(() => {
        if (auth.loggedIn) {
            navigate("/");
        }
    }, [auth.loggedIn]);

    const handleUsernameInput = (event: any) => {
        setUsername(event.target.value);
    };

    const handlePasswordInput = (event: any) => {
        setPassword(event.target.value);
    };

    const login = () => {
        setErr(auth.loginUser(username, password, oauth));
    };

    const register = () => {
        setErr(auth.registerUser(username, password, oauth));
    };

    if (oauth) {
        return (
            <div className="screen">
                <div style={{ display: "flex", height: "100%", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
                    <h1>OAuth Connect / Create New Account</h1>
                    <input type="text" placeholder="Username" onKeyUp={handleUsernameInput}/>
                    <input style={{marginTop: "8px"}} type="password" placeholder="Password" onKeyUp={handlePasswordInput}/>
                    <div style={{marginTop: "8px", display: "flex"}}>
                        <button onClick={login}>Connect Account</button>
                        <button style={{marginLeft: "32px"}} onClick={register}>Create New Account</button>
                    </div>
                    <div style={{color: "red"}}>
                        { err }
                    </div>
                </div>
            </div>
        )
    }
    return (
        <div className="screen">
            <div style={{ display: "flex", height: "100%", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
                <h1>Log In / Register</h1>
                <input style={{marginTop: "8px"}} type="text" placeholder="Username" onKeyUp={handleUsernameInput}/>
                <input style={{marginTop: "8px"}} type="password" placeholder="Password" onKeyUp={handlePasswordInput}/>
                <div style={{marginTop: "8px", display: "flex"}}>
                    <button onClick={login}>Login</button>
                    <button style={{marginLeft: "32px"}} onClick={register}>Register</button>
                </div>
                <a style={{marginTop: "8px"}} href={import.meta.env.VITE_BACKEND_URL + "/auth/google"}>Login with Google</a>
                <a style={{marginTop: "8px"}} href={import.meta.env.VITE_BACKEND_URL + "/auth/github"}>Login with GitHub</a>
                <a style={{marginTop: "8px"}} href={import.meta.env.VITE_BACKEND_URL + "/auth/oidc"}>Login with Course Provider</a>
                <div style={{color: "red"}}>
                    { err }
                </div>
            </div>
        </div>
    )
}