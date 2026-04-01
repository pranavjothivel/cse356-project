import { createContext, useEffect, useState } from "react";

import { useNavigate } from "react-router-dom";

const AuthContext = createContext(null as any);

function AuthContextProvider(props: any) {
    const navigate = useNavigate();

    const [auth, setAuth] = useState({
        user: null,
        loggedIn: null
    }) as any;

    useEffect(() => {
        auth.getLoggedIn();
    }, []);

    auth.loginUser = async (username: string, password: string, oauth: boolean | undefined) => {
        try {
            let res;
            if (oauth) {
                res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/oauth-connect/existing", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({username, password})
                });
            }
            else {
                res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/login", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({username, password})
                });
            }

            if (res.ok) {
                setAuth((prevState:any) => ({user: prevState.user, loggedIn: true}));
                await auth.getLoggedIn();
                navigate("/");
                return "";
            }
            else {
                return "Error";
            }
        }
        catch (err) {
            console.log(err);
            return "Error";
        }
    };

    auth.registerUser = async (username: string, password: string, oauth: boolean | undefined) => {
        try {
            let res;
            if (oauth) {
                res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/oauth-connect/new", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({username, password})
                });
            }
            else {
                res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/register", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({username, password})
                });
            }

            if (res.ok) {
                setAuth((prevState:any) => ({user: prevState.user, loggedIn: true}));
                await auth.getLoggedIn();
                navigate("/");
                return "";
            }
            else {
                return "Error";
            }
        }
        catch (err) {
            console.log(err);
            return "Error";
        }
    };

    auth.getLoggedIn = async () => {
        try {
            let res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/me", {
                credentials: "include"
            });

            if (res.ok) {
                let body = await res.json();
                setAuth((prevState: any) => ({
                    user: { id: body.id, username: body.username, displayName: body.displayName },
                    loggedIn: true
                }));
            }
            else {
                setAuth({
                    user: null,
                    loggedIn: false
                });
            }
        }
        catch (err) {
            console.log(err);
            setAuth({
                user: null,
                loggedIn: false
            });
        }
        
    };

    auth.logout = async () => {
        let res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/logout", {
                method: "POST",
                credentials: "include",
            });
        setAuth({
            user: null,
            loggedIn: false
        });
    }
    
    return (
        <AuthContext.Provider value={{
            auth
        }}>
            {props.children}
        </AuthContext.Provider>
    );
}

export default AuthContext;
export { AuthContextProvider };